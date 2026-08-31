import { CustomerJoinedWaitingList } from '../../events/domain-events/customer-joined-waiting-list.event';
import { SpotOfferedToWaitingCustomer } from '../../events/domain-events/spot-offered-to-waiting-customer.event';
import { CustomerId } from '../customer.entity';
import { EventSectionId } from '../event-section';
import { EventSpotId } from '../event-spot';
import { EventId } from '../event.entity';
import { WaitingListEntryStatus } from '../waiting-list-entry.entity';
import { WaitingList } from '../waiting-list.entity';
import { initOrm } from './helpers';

describe('WaitingList Entity Unit Tests', () => {
  initOrm();

  function makeWaitingList() {
    return WaitingList.create({
      event_id: new EventId(),
      section_id: new EventSectionId(),
    });
  }

  test('deve criar uma entrada PENDING na ordem de chegada', () => {
    const waitingList = makeWaitingList();
    const customer1 = new CustomerId();
    const customer2 = new CustomerId();

    const entry1 = waitingList.addEntry(customer1);
    const entry2 = waitingList.addEntry(customer2);

    expect(entry1.status).toBe(WaitingListEntryStatus.PENDING);
    expect(entry1.position).toBe(1);
    expect(entry2.position).toBe(2);
    expect(
      waitingList.entries_by_arrival.map((entry) => entry.customer_id.value),
    ).toEqual([customer1.value, customer2.value]);
  });

  test('deve registrar o CustomerJoinedWaitingList ao entrar na fila', () => {
    const waitingList = makeWaitingList();
    const customer_id = new CustomerId();

    waitingList.addEntry(customer_id);

    const [event] = [...waitingList.events];
    expect(event).toBeInstanceOf(CustomerJoinedWaitingList);
    expect((event as CustomerJoinedWaitingList).aggregate_id).toEqual(
      waitingList.id,
    );
    expect((event as CustomerJoinedWaitingList).event_id).toEqual(
      waitingList.event_id,
    );
    expect((event as CustomerJoinedWaitingList).section_id).toEqual(
      waitingList.section_id,
    );
    expect((event as CustomerJoinedWaitingList).customer_id).toEqual(
      customer_id,
    );
  });

  test('não deve aceitar o mesmo cliente com entrada PENDING na fila', () => {
    const waitingList = makeWaitingList();
    const customer_id = new CustomerId();
    waitingList.addEntry(customer_id);
    waitingList.clearEvents();

    expect(() => waitingList.addEntry(customer_id)).toThrow(
      'Customer already in waiting list',
    );
    expect(waitingList.entries.size).toBe(1);
    expect(waitingList.events.size).toBe(0);
  });

  test('deve aceitar de volta um cliente cuja entrada já foi NOTIFIED', () => {
    const waitingList = makeWaitingList();
    const customer_id = new CustomerId();
    waitingList.addEntry(customer_id);
    waitingList.offerSpotToNext(new EventSpotId());

    expect(() => waitingList.addEntry(customer_id)).not.toThrow();
    expect(waitingList.entries.size).toBe(2);
  });

  test('deve promover a primeira entrada pendente para NOTIFIED', () => {
    const waitingList = makeWaitingList();
    const first = waitingList.addEntry(new CustomerId());
    const second = waitingList.addEntry(new CustomerId());
    waitingList.clearEvents();
    const spot_id = new EventSpotId();

    const notified = waitingList.offerSpotToNext(spot_id);

    expect(notified).toBe(first);
    expect(first.status).toBe(WaitingListEntryStatus.NOTIFIED);
    expect(second.status).toBe(WaitingListEntryStatus.PENDING);
  });

  test('deve registrar o SpotOfferedToWaitingCustomer ao promover', () => {
    const waitingList = makeWaitingList();
    const entry = waitingList.addEntry(new CustomerId());
    waitingList.clearEvents();
    const spot_id = new EventSpotId();

    waitingList.offerSpotToNext(spot_id);

    const [event] = [...waitingList.events];
    expect(event).toBeInstanceOf(SpotOfferedToWaitingCustomer);
    expect((event as SpotOfferedToWaitingCustomer).customer_id).toEqual(
      entry.customer_id,
    );
    expect((event as SpotOfferedToWaitingCustomer).event_id).toEqual(
      waitingList.event_id,
    );
    expect((event as SpotOfferedToWaitingCustomer).section_id).toEqual(
      waitingList.section_id,
    );
    expect((event as SpotOfferedToWaitingCustomer).spot_id).toEqual(spot_id);
  });

  test('não deve notificar duas vezes a mesma entrada', () => {
    const waitingList = makeWaitingList();
    const entry = waitingList.addEntry(new CustomerId());
    waitingList.offerSpotToNext(new EventSpotId());
    waitingList.clearEvents();

    const notified = waitingList.offerSpotToNext(new EventSpotId());

    expect(notified).toBeNull();
    expect(entry.status).toBe(WaitingListEntryStatus.NOTIFIED);
    expect(waitingList.events.size).toBe(0);
  });

  test('notificar com a fila vazia não faz nada', () => {
    const waitingList = makeWaitingList();

    const notified = waitingList.offerSpotToNext(new EventSpotId());

    expect(notified).toBeNull();
    expect(waitingList.events.size).toBe(0);
  });
});
