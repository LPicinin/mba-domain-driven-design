import { EntityManager } from '@mikro-orm/mysql';
import { Event, EventId } from '../../../domain/entities/event.entity';
import { IEventRepository } from '../../../domain/repositories/event-repository.interface';
import { EventSpotId } from '../../../domain/entities/event-spot';

export class EventMysqlRepository implements IEventRepository {
  constructor(private entityManager: EntityManager) {}

  async add(entity: Event): Promise<void> {
    this.entityManager.persist(entity);
  }

  async findById(id: string | EventId): Promise<Event> {
    return this.entityManager.findOne(Event, {
      id: typeof id === 'string' ? new EventId(id) : id,
    });
  }

  async findAll(): Promise<Event[]> {
    return this.entityManager.find(Event, {});
  }

  async findByEventSpotId(spotId: EventSpotId): Promise<Event | null> {
    // Busca apenas o id do evento dono do spot, atravessando seções e lugares.
    // O agregado é recarregado inteiro por findById para não vir com as
    // coleções filtradas pelo join.
    const [row] = await this.entityManager
      .createQueryBuilder(Event, 'e')
      .select('e.id')
      .join('e.sections', 's')
      .join('s.spots', 'sp')
      .where({ 'sp.id': spotId })
      .limit(1)
      .execute<{ id: string }[]>();

    return row ? this.findById(row.id) : null;
  }

  async delete(entity: Event): Promise<void> {
    await this.entityManager.remove(entity);
  }
}
