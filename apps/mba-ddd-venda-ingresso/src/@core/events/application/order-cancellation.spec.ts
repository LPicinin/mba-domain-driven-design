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
import { EventSpotReleasedHandler } from './handlers/event-spot-released.handler';
import { OrderCancelledHandler } from './handlers/order-cancelled.handler';
import { OrderService } from './order.service';
import { PaymentGateway } from './payment.gateway';
import { WaitingListService } from './waiting-list.service';

/**
 * Fluxo de ponta a ponta, em processo: um único comando de cancelamento
 * precisa disparar toda a cadeia de reações registradas no DomainEventManager,
 * reproduzindo aqui o que o EventsModule.onModuleInit faz na aplicação.
 */
describe('Cancelamento de pedido - fluxo de ponta a ponta', () => {
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

  async function makeSut() {
    const em = orm.em.fork();
    const uow = new UnitOfWorkMikroOrm(em);
    const domainEventManager = new DomainEventManager();
    const applicationService = new ApplicationService(uow, domainEventManager);

    const partnerRepo = new PartnerMysqlRepository(em);
    const customerRepo = new CustomerMysqlRepository(em);
    const eventRepo = new EventMysqlRepository(em);
    const orderRepo = new OrderMysqlRepository(em);
    const spotReservationRepo = new SpotReservationMysqlRepository(em);
    const waitingListRepo = new WaitingListMysqlRepository(em);

    const orderService = new OrderService(
      orderRepo,
      customerRepo,
      eventRepo,
      spotReservationRepo,
      uow,
      new PaymentGateway(),
      applicationService,
    );
    const waitingListService = new WaitingListService(
      customerRepo,
      eventRepo,
      waitingListRepo,
      applicationService,
    );

    // Mesmo registro feito por EventsModule.onModuleInit.
    const orderCancelledHandler = new OrderCancelledHandler(
      eventRepo,
      spotReservationRepo,
      domainEventManager,
    );
    OrderCancelledHandler.listensTo().forEach((eventName) =>
      domainEventManager.register(eventName, (event) =>
        orderCancelledHandler.handle(event),
      ),
    );

    const eventSpotReleasedHandler = new EventSpotReleasedHandler(
      waitingListRepo,
      domainEventManager,
    );
    EventSpotReleasedHandler.listensTo().forEach((eventName) =>
      domainEventManager.register(eventName, (event) =>
        eventSpotReleasedHandler.handle(event),
      ),
    );

    return {
      em,
      uow,
      domainEventManager,
      eventRepo,
      spotReservationRepo,
      waitingListRepo,
      orderService,
      waitingListService,
    };
  }

  async function arrangeSoldOutSectionWithWaitingCustomer(sut: {
    em: any;
    uow: UnitOfWorkMikroOrm;
    orderService: OrderService;
    waitingListService: WaitingListService;
  }) {
    const { em, uow, orderService, waitingListService } = sut;
    const partnerRepo = new PartnerMysqlRepository(em);
    const customerRepo = new CustomerMysqlRepository(em);
    const eventRepo = new EventMysqlRepository(em);

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
    const [spot] = section.spots;

    // Cliente A compra o único lugar: a seção esgota.
    const order = await orderService.create({
      event_id: event.id.value,
      section_id: section.id.value,
      spot_id: spot.id.value,
      customer_id: customerA.id.value,
      card_token: 'tok_visa',
    });

    // Cliente B entra na fila da seção esgotada.
    await waitingListService.join({
      event_id: event.id.value,
      section_id: section.id.value,
      customer_id: customerB.id.value,
    });

    em.clear();
    return { event, section, spot, customerA, customerB, order };
  }

  test('um único cancelamento libera o lugar, remove a trava e notifica o primeiro da fila', async () => {
    const sut = await makeSut();
    const { event, section, spot, customerB, order } =
      await arrangeSoldOutSectionWithWaitingCustomer(sut);

    await sut.orderService.cancel(order.id.value);

    sut.em.clear();

    const eventAfter = await sut.eventRepo.findById(event.id);
    const spotAfter = eventAfter.sections
      .find((s) => s.id.equals(section.id))
      .spots.find((s) => s.id.equals(spot.id));
    expect(spotAfter.is_reserved).toBe(false);

    const reservationAfter = await sut.spotReservationRepo.findById(spot.id);
    expect(reservationAfter).toBeNull();

    const waitingListAfter = await sut.waitingListRepo.findByEventAndSection(
      event.id,
      section.id,
    );
    const [firstEntry] = waitingListAfter.entries_by_arrival;
    expect(firstEntry.customer_id.value).toBe(customerB.id.value);
    expect(firstEntry.status).toBe(WaitingListEntryStatus.NOTIFIED);
  });

  test('a cadeia publica os eventos de domínio e o de integração da oferta', async () => {
    const sut = await makeSut();
    const publishedDomainEvents: string[] = [];
    sut.domainEventManager.register('*', async (event) => {
      publishedDomainEvents.push(event.constructor.name);
    });
    const integrationEvents: string[] = [];
    sut.domainEventManager.registerForIntegrationEvent(
      'SpotOfferedToWaitingCustomer',
      async (event) => {
        integrationEvents.push(event.constructor.name);
      },
    );

    const { order } = await arrangeSoldOutSectionWithWaitingCustomer(sut);
    publishedDomainEvents.length = 0;

    await sut.orderService.cancel(order.id.value);

    expect(publishedDomainEvents).toEqual(
      expect.arrayContaining([
        'OrderCancelled',
        'EventSpotReleased',
        'SpotOfferedToWaitingCustomer',
      ]),
    );
    expect(integrationEvents).toEqual(['SpotOfferedToWaitingCustomer']);
  });

  test('sem fila na seção, o cancelamento libera o lugar sem erro', async () => {
    const sut = await makeSut();
    const { em, uow, orderService } = sut;
    const partnerRepo = new PartnerMysqlRepository(em);
    const customerRepo = new CustomerMysqlRepository(em);
    const eventRepo = new EventMysqlRepository(em);

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
    const customer = Customer.create({
      name: 'Customer A',
      cpf: '70375887091',
    });
    await customerRepo.add(customer);
    await uow.commit();

    const [section] = event.sections;
    const [spot] = section.spots;
    const order = await orderService.create({
      event_id: event.id.value,
      section_id: section.id.value,
      spot_id: spot.id.value,
      customer_id: customer.id.value,
      card_token: 'tok_visa',
    });
    em.clear();

    await expect(orderService.cancel(order.id.value)).resolves.toBeDefined();

    em.clear();
    const eventAfter = await sut.eventRepo.findById(event.id);
    const spotAfter = eventAfter.sections
      .find((s) => s.id.equals(section.id))
      .spots.find((s) => s.id.equals(spot.id));
    expect(spotAfter.is_reserved).toBe(false);
  });

  test('não deve cancelar um pedido inexistente', async () => {
    const sut = await makeSut();

    await expect(
      sut.orderService.cancel('9366b7dc-2d71-4799-b91c-c64adb205104'),
    ).rejects.toThrow('Order not found');
  });
});
