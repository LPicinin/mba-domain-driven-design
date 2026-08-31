import { MikroORM, MySqlDriver } from '@mikro-orm/mysql';
import { Customer } from '../../../../domain/entities/customer.entity';
import { Partner } from '../../../../domain/entities/partner.entity';
import { WaitingListEntryStatus } from '../../../../domain/entities/waiting-list-entry.entity';
import { WaitingList } from '../../../../domain/entities/waiting-list.entity';
import {
  CustomerSchema,
  EventSchema,
  EventSectionSchema,
  EventSpotSchema,
  PartnerSchema,
  WaitingListEntrySchema,
  WaitingListSchema,
} from '../../schemas';
import { CustomerMysqlRepository } from '../customer-mysql.repository';
import { EventMysqlRepository } from '../event-mysql.repository';
import { PartnerMysqlRepository } from '../partner-mysql.repository';
import { WaitingListMysqlRepository } from '../waiting-list-mysql.repository';

describe('WaitingList repository', () => {
  let orm: MikroORM;

  beforeEach(async () => {
    orm = await MikroORM.init<MySqlDriver>({
      entities: [
        PartnerSchema,
        CustomerSchema,
        EventSchema,
        EventSectionSchema,
        EventSpotSchema,
        WaitingListSchema,
        WaitingListEntrySchema,
      ],
      dbName: 'events',
      host: 'localhost',
      port: 3307,
      user: 'root',
      password: 'root',
      type: 'mysql',
      forceEntityConstructor: true,
    });
    await orm.schema.refreshDatabase();
  });

  afterEach(async () => {
    await orm.close();
  });

  async function arrangeSoldOutSection() {
    const em = orm.em.fork();
    const partnerRepo = new PartnerMysqlRepository(em);
    const eventRepo = new EventMysqlRepository(em);
    const customerRepo = new CustomerMysqlRepository(em);

    const partner = Partner.create({ name: 'Partner 1' });
    await partnerRepo.add(partner);

    const event = partner.initEvent({
      name: 'Event 1',
      description: 'Event 1 description',
      date: new Date(),
    });
    event.addSection({
      name: 'Section 1',
      description: 'Section 1 description',
      price: 100,
      total_spots: 1,
    });
    event.publishAll();
    await eventRepo.add(event);

    const customer1 = Customer.create({
      name: 'Customer 1',
      cpf: '70375887091',
    });
    const customer2 = Customer.create({
      name: 'Customer 2',
      cpf: '99346413050',
    });
    await customerRepo.add(customer1);
    await customerRepo.add(customer2);

    await em.flush();

    const [section] = event.sections;
    return { em, event, section, customer1, customer2 };
  }

  test('deve persistir a lista com suas entradas e recarregá-la na ordem de chegada', async () => {
    const { em, event, section, customer1, customer2 } =
      await arrangeSoldOutSection();
    const waitingListRepo = new WaitingListMysqlRepository(em);

    const waitingList = WaitingList.create({
      event_id: event.id,
      section_id: section.id,
    });
    waitingList.addEntry(customer1.id);
    waitingList.addEntry(customer2.id);

    await waitingListRepo.add(waitingList);
    await em.flush();
    em.clear();

    const waitingListFound = await waitingListRepo.findById(waitingList.id);

    expect(waitingListFound).not.toBeNull();
    expect(waitingListFound.id.value).toBe(waitingList.id.value);
    expect(waitingListFound.event_id.value).toBe(event.id.value);
    expect(waitingListFound.section_id.value).toBe(section.id.value);
    expect(waitingListFound.entries.size).toBe(2);

    const entries = waitingListFound.entries_by_arrival;
    expect(entries.map((entry) => entry.position)).toEqual([1, 2]);
    expect(entries.map((entry) => entry.customer_id.value)).toEqual([
      customer1.id.value,
      customer2.id.value,
    ]);
    expect(entries.map((entry) => entry.status)).toEqual([
      WaitingListEntryStatus.PENDING,
      WaitingListEntryStatus.PENDING,
    ]);
  });

  test('deve encontrar a lista por evento e seção', async () => {
    const { em, event, section, customer1 } = await arrangeSoldOutSection();
    const waitingListRepo = new WaitingListMysqlRepository(em);

    const waitingList = WaitingList.create({
      event_id: event.id,
      section_id: section.id,
    });
    waitingList.addEntry(customer1.id);
    await waitingListRepo.add(waitingList);
    await em.flush();
    em.clear();

    const waitingListFound = await waitingListRepo.findByEventAndSection(
      event.id,
      section.id,
    );

    expect(waitingListFound).not.toBeNull();
    expect(waitingListFound.id.value).toBe(waitingList.id.value);
    expect(waitingListFound.entries.size).toBe(1);
  });

  test('deve retornar null quando a seção não tem lista de espera', async () => {
    const { em, event, section } = await arrangeSoldOutSection();
    const waitingListRepo = new WaitingListMysqlRepository(em);

    const waitingListFound = await waitingListRepo.findByEventAndSection(
      event.id,
      section.id,
    );

    expect(waitingListFound).toBeNull();
  });

  test('deve persistir a promoção de uma entrada para NOTIFIED', async () => {
    const { em, event, section, customer1 } = await arrangeSoldOutSection();
    const waitingListRepo = new WaitingListMysqlRepository(em);

    const waitingList = WaitingList.create({
      event_id: event.id,
      section_id: section.id,
    });
    waitingList.addEntry(customer1.id);
    await waitingListRepo.add(waitingList);
    await em.flush();
    em.clear();

    const [spot] = section.spots;
    const waitingListToNotify = await waitingListRepo.findByEventAndSection(
      event.id,
      section.id,
    );
    waitingListToNotify.offerSpotToNext(spot.id);
    await waitingListRepo.add(waitingListToNotify);
    await em.flush();
    em.clear();

    const waitingListFound = await waitingListRepo.findByEventAndSection(
      event.id,
      section.id,
    );

    expect(waitingListFound.entries_by_arrival[0].status).toBe(
      WaitingListEntryStatus.NOTIFIED,
    );
  });
});
