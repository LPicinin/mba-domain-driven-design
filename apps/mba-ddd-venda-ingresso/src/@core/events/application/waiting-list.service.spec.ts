import { MikroORM, MySqlDriver } from '@mikro-orm/mysql';
import { ApplicationService } from '../../common/application/application.service';
import { DomainEventManager } from '../../common/domain/domain-event-manager';
import { UnitOfWorkMikroOrm } from '../../common/infra/unit-of-work-mikro-orm';
import { Customer } from '../domain/entities/customer.entity';
import { Partner } from '../domain/entities/partner.entity';
import { WaitingListEntryStatus } from '../domain/entities/waiting-list-entry.entity';
import { CustomerMysqlRepository } from '../infra/db/repositories/customer-mysql.repository';
import { EventMysqlRepository } from '../infra/db/repositories/event-mysql.repository';
import { OrderMysqlRepository } from '../infra/db/repositories/order-mysql.repository';
import { PartnerMysqlRepository } from '../infra/db/repositories/partner-mysql.repository';
import { SpotReservationMysqlRepository } from '../infra/db/repositories/spot-reservation-mysql.repository';
import { WaitingListMysqlRepository } from '../infra/db/repositories/waiting-list-mysql.repository';
import {
  CustomerSchema,
  EventSchema,
  EventSectionSchema,
  EventSpotSchema,
  OrderSchema,
  PartnerSchema,
  SpotReservationSchema,
  WaitingListEntrySchema,
  WaitingListSchema,
} from '../infra/db/schemas';
import { OrderService } from './order.service';
import { PaymentGateway } from './payment.gateway';
import { WaitingListService } from './waiting-list.service';

describe('WaitingListService', () => {
  let orm: MikroORM;

  beforeEach(async () => {
    orm = await MikroORM.init<MySqlDriver>({
      entities: [
        PartnerSchema,
        CustomerSchema,
        EventSchema,
        EventSectionSchema,
        EventSpotSchema,
        OrderSchema,
        SpotReservationSchema,
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

  async function makeSut(options: { total_spots: number }) {
    const em = orm.em.fork();
    const uow = new UnitOfWorkMikroOrm(em);
    const applicationService = new ApplicationService(
      uow,
      new DomainEventManager(),
    );
    const partnerRepo = new PartnerMysqlRepository(em);
    const customerRepo = new CustomerMysqlRepository(em);
    const eventRepo = new EventMysqlRepository(em);
    const waitingListRepo = new WaitingListMysqlRepository(em);

    const waitingListService = new WaitingListService(
      customerRepo,
      eventRepo,
      waitingListRepo,
      applicationService,
    );
    const orderService = new OrderService(
      new OrderMysqlRepository(em),
      customerRepo,
      eventRepo,
      new SpotReservationMysqlRepository(em),
      uow,
      new PaymentGateway(),
      applicationService,
    );

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
      total_spots: options.total_spots,
    });
    event.publishAll();
    await eventRepo.add(event);

    const customerA = Customer.create({
      name: 'Customer A',
      cpf: '70375887091',
    });
    const customerB = Customer.create({
      name: 'Customer B',
      cpf: '99346413050',
    });
    await customerRepo.add(customerA);
    await customerRepo.add(customerB);
    await uow.commit();

    const [section] = event.sections;
    return {
      em,
      event,
      section,
      customerA,
      customerB,
      orderService,
      waitingListService,
    };
  }

  async function sellOut(sut: Awaited<ReturnType<typeof makeSut>>) {
    const [spot] = sut.section.spots;
    await sut.orderService.create({
      event_id: sut.event.id.value,
      section_id: sut.section.id.value,
      spot_id: spot.id.value,
      customer_id: sut.customerA.id.value,
      card_token: 'tok_visa',
    });
    sut.em.clear();
  }

  test('deve entrar na fila de uma seção esgotada', async () => {
    const sut = await makeSut({ total_spots: 1 });
    await sellOut(sut);

    const entry = await sut.waitingListService.join({
      event_id: sut.event.id.value,
      section_id: sut.section.id.value,
      customer_id: sut.customerB.id.value,
    });

    expect(entry.customer_id.value).toBe(sut.customerB.id.value);
    expect(entry.status).toBe(WaitingListEntryStatus.PENDING);
    expect(entry.position).toBe(1);
  });

  test('não deve entrar na fila de uma seção com lugar disponível', async () => {
    const sut = await makeSut({ total_spots: 2 });
    await sellOut(sut);

    await expect(
      sut.waitingListService.join({
        event_id: sut.event.id.value,
        section_id: sut.section.id.value,
        customer_id: sut.customerB.id.value,
      }),
    ).rejects.toThrow('Section is not sold out');
  });

  test('não deve entrar duas vezes na mesma fila', async () => {
    const sut = await makeSut({ total_spots: 1 });
    await sellOut(sut);
    const input = {
      event_id: sut.event.id.value,
      section_id: sut.section.id.value,
      customer_id: sut.customerB.id.value,
    };
    await sut.waitingListService.join(input);
    sut.em.clear();

    await expect(sut.waitingListService.join(input)).rejects.toThrow(
      'Customer already in waiting list',
    );
  });

  test('não deve entrar na fila com cliente inexistente', async () => {
    const sut = await makeSut({ total_spots: 1 });
    await sellOut(sut);

    await expect(
      sut.waitingListService.join({
        event_id: sut.event.id.value,
        section_id: sut.section.id.value,
        customer_id: '9366b7dc-2d71-4799-b91c-c64adb205104',
      }),
    ).rejects.toThrow('Customer not found');
  });

  test('não deve entrar na fila de um evento inexistente', async () => {
    const sut = await makeSut({ total_spots: 1 });
    await sellOut(sut);

    await expect(
      sut.waitingListService.join({
        event_id: '9366b7dc-2d71-4799-b91c-c64adb205104',
        section_id: sut.section.id.value,
        customer_id: sut.customerB.id.value,
      }),
    ).rejects.toThrow('Event not found');
  });

  test('não deve entrar na fila de uma seção inexistente', async () => {
    const sut = await makeSut({ total_spots: 1 });
    await sellOut(sut);

    await expect(
      sut.waitingListService.join({
        event_id: sut.event.id.value,
        section_id: '9366b7dc-2d71-4799-b91c-c64adb205104',
        customer_id: sut.customerB.id.value,
      }),
    ).rejects.toThrow('Section not found');
  });

  test('deve listar a fila da seção na ordem de chegada', async () => {
    const sut = await makeSut({ total_spots: 1 });
    await sellOut(sut);
    await sut.waitingListService.join({
      event_id: sut.event.id.value,
      section_id: sut.section.id.value,
      customer_id: sut.customerB.id.value,
    });
    sut.em.clear();

    const entries = await sut.waitingListService.list(
      sut.event.id.value,
      sut.section.id.value,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].customer_id.value).toBe(sut.customerB.id.value);
  });

  test('deve listar vazio quando a seção não tem fila', async () => {
    const sut = await makeSut({ total_spots: 1 });

    const entries = await sut.waitingListService.list(
      sut.event.id.value,
      sut.section.id.value,
    );

    expect(entries).toEqual([]);
  });
});
