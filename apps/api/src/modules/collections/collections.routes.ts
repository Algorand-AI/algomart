import { Slug } from '@algomart/schemas'
import { CollectionsService } from '@algomart/shared/services'
import { FastifyReply, FastifyRequest } from 'fastify'

export async function getAllCollections(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const collectionsService = request
    .getContainer()
    .get<CollectionsService>(CollectionsService.name)
  // TODO: get language from request
  const collections = await collectionsService.getAllCollections()
  reply.send(collections)
}

export async function getCollection(
  request: FastifyRequest<{ Params: Slug }>,
  reply: FastifyReply
) {
  const collectionsService = request
    .getContainer()
    .get<CollectionsService>(CollectionsService.name)
  // TODO: get language from request
  const collection = await collectionsService.getCollectionBySlug(
    request.params.slug
  )

  if (collection) reply.send(collection)
  else reply.notFound()
}
