import { OrderCancelled } from '../../events/domain-events/order-cancelled.event';
import { CustomerId } from '../customer.entity';
import { EventSpotId } from '../event-spot';
import { Order, OrderStatus } from '../order.entity';
import { initOrm } from './helpers';

describe('Order Entity Unit Tests', () => {
  initOrm();

  function makeOrder() {
    const order = Order.create({
      customer_id: new CustomerId(),
      event_spot_id: new EventSpotId(),
      amount: 100,
    });
    order.clearEvents();
    return order;
  }

  test('deve cancelar um pedido pendente', () => {
    const order = makeOrder();

    order.cancel();

    expect(order.status).toBe(OrderStatus.CANCELLED);
  });

  test('deve cancelar um pedido pago', () => {
    const order = makeOrder();
    order.pay();
    order.clearEvents();

    order.cancel();

    expect(order.status).toBe(OrderStatus.CANCELLED);
  });

  test('deve registrar o OrderCancelled com o event_spot_id', () => {
    const order = makeOrder();

    order.cancel();

    const [event] = [...order.events];
    expect(event).toBeInstanceOf(OrderCancelled);
    expect((event as OrderCancelled).aggregate_id).toEqual(order.id);
    expect((event as OrderCancelled).status).toBe(OrderStatus.CANCELLED);
    expect((event as OrderCancelled).event_spot_id).toEqual(
      order.event_spot_id,
    );
  });

  test('não deve cancelar um pedido já cancelado', () => {
    const order = makeOrder();
    order.cancel();
    order.clearEvents();

    expect(() => order.cancel()).toThrow('Order already cancelled');
    expect(order.events.size).toBe(0);
  });

  test('deve expor o status legível no toJSON', () => {
    const order = makeOrder();
    order.cancel();

    expect(order.toJSON().status).toBe('CANCELLED');
  });
});
