import pino from 'pino'
import {
  AlgorandTransactionStatus,
  CreateUserAccountRequest,
  ExternalId,
  PublicAccount,
} from '@algomart/schemas'
import { UpdateUserAccount } from '@algomart/schemas'
import { Username } from '@algomart/schemas'
import { Knex } from 'knex'
import { Transaction } from 'objection'

import { AlgorandAdapter } from '@algomart/shared/adapters'
import { AlgorandAccountModel } from '@algomart/shared/models'
import {
  AlgorandTransactionModel,
  UserAccountModel,
} from '@algomart/shared/models'
import { invariant, userInvariant } from '@algomart/shared/utils'

export default class AccountsService {
  logger: pino.Logger<unknown>
  constructor(
    private readonly algorand: AlgorandAdapter,
    logger: pino.Logger<unknown>
  ) {
    this.logger = logger.child({ context: this.constructor.name })
  }

  async create(
    request: CreateUserAccountRequest,
    trx?: Transaction,
    knexRead?: Knex
  ) {
    // 1. Check for a username or externalId collision
    const existing = await UserAccountModel.query(knexRead)
      .where({
        username: request.username,
      })
      .orWhere({ externalId: request.externalId })
      .first()
    userInvariant(!existing, 'username or externalId already exists', 400)

    // 2. generate algorand account (i.e. wallet)
    const result = this.algorand.generateAccount(request.passphrase)

    // 3. save account with encrypted mnemonic
    await UserAccountModel.query(trx).insertGraph({
      currency: request.currency,
      username: request.username,
      email: request.email,
      locale: request.locale,
      externalId: request.externalId,
      algorandAccount: {
        address: result.address,
        encryptedKey: result.encryptedMnemonic,
      },
    })

    // 4. return "public" user account
    const userAccount = await UserAccountModel.query(trx)
      .findOne({
        username: request.username,
      })
      .withGraphJoined('algorandAccount.creationTransaction')

    return this.mapPublicAccount(userAccount)
  }

  async initializeAccount(
    userId: string,
    passphrase: string,
    trx?: Transaction,
    knexRead?: Knex
  ) {
    const userAccount = await UserAccountModel.query(knexRead)
      .findById(userId)
      .withGraphJoined('algorandAccount')

    userInvariant(userAccount, 'user account not found', 404)
    invariant(
      userAccount.algorandAccount,
      `user account ${userId} missing algorand account`
    )
    userInvariant(
      userAccount.algorandAccount.creationTransactionId === null,
      `user account ${userId} already initialized`
    )

    // generate transactions to fund the account and opt-out of staking rewards
    const { signedTransactions, transactionIds } =
      await this.algorand.initialFundTransactions(
        userAccount.algorandAccount.encryptedKey,
        passphrase
      )

    // send and wait for transaction to be confirmed
    await this.algorand.submitTransaction(signedTransactions)
    await this.algorand.waitForConfirmation(transactionIds[0])

    const transactions = [
      // funding transaction
      await AlgorandTransactionModel.query(trx).insert({
        address: transactionIds[0],
        status: AlgorandTransactionStatus.Confirmed,
      }),
      // non-participation transaction
      await AlgorandTransactionModel.query(trx).insert({
        address: transactionIds[1],
        status: AlgorandTransactionStatus.Pending,
      }),
    ]

    // update algorand account, its now funded
    await AlgorandAccountModel.query(trx)
      .patch({
        creationTransactionId: transactions[0].id,
      })
      .where({ id: userAccount.algorandAccountId })
  }

  async updateAccount(
    {
      email,
      externalId,
      showProfile,
      username,
      locale,
      currency,
    }: UpdateUserAccount & ExternalId,
    trx?: Transaction
  ) {
    const result = await UserAccountModel.query(trx)
      .where({ externalId })
      .patch({
        currency,
        email,
        locale,
        showProfile,
        username,
      })
    userInvariant(result === 1, 'user account not found', 404)
  }

  private mapPublicAccount(
    userAccount: UserAccountModel | null | undefined
  ): PublicAccount {
    userInvariant(userAccount, 'user account not found', 404)

    invariant(userAccount.algorandAccount, 'algorand account not loaded')

    return {
      address: userAccount.algorandAccount.address,
      currency: userAccount.currency,
      externalId: userAccount.externalId,
      username: userAccount.username,
      email: userAccount.email,
      locale: userAccount.locale,
      status: userAccount.algorandAccount.creationTransaction
        ? userAccount.algorandAccount.creationTransaction.status
        : undefined,
      showProfile: userAccount.showProfile,
    }
  }

  async getByExternalId(request: ExternalId, knexRead?: Knex) {
    const userAccount = await UserAccountModel.query(knexRead)
      .findOne({
        externalId: request.externalId,
      })
      .withGraphJoined('algorandAccount.creationTransaction')

    return this.mapPublicAccount(userAccount)
  }

  async getByUsername(request: Username, knexRead?: Knex) {
    const userAccount = await UserAccountModel.query(knexRead)
      .findOne({
        username: request.username,
      })
      .withGraphJoined('algorandAccount.creationTransaction')

    return this.mapPublicAccount(userAccount)
  }

  async verifyPassphraseFor(
    externalId: string,
    passphrase: string,
    knexRead?: Knex
  ) {
    const userAccount = await UserAccountModel.query(knexRead)
      .findOne({ externalId })
      .withGraphJoined('algorandAccount')

    userInvariant(userAccount, 'user account not found', 404)

    if (!userAccount.algorandAccount?.encryptedKey) {
      return false
    }

    return this.algorand.isValidPassphrase(
      userAccount.algorandAccount.encryptedKey,
      passphrase
    )
  }

  async verifyUsername(username: string, knexRead?: Knex) {
    const userId = await UserAccountModel.query(knexRead)
      .findOne({ username })
      .select('id')
    return Boolean(userId)
  }

  async removeUser(request: ExternalId, trx?: Transaction, knexRead?: Knex) {
    const user = await UserAccountModel.query(knexRead).findOne({
      externalId: request.externalId,
    })
    if (user) {
      await UserAccountModel.query(trx).deleteById(user.id)
      return true
    }
    return false
  }
}