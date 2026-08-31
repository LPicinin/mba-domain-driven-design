import { EventSpotReleased } from '../../events/domain-events/event-spot-released.event';
import { EventSpotId } from '../event-spot';
import { Event } from '../event.entity';
import { PartnerId } from '../partner.entity';
import { initOrm } from './helpers';

describe('Event Entity Unit Tests', () => {
  initOrm();
  it('deve criar um evento', () => {
    const event = Event.create({
      name: 'Evento 1',
      description: 'Descrição do evento 1',
      date: new Date(),
      partner_id: new PartnerId(),
    });

    event.addSection({
      name: 'Sessão 1',
      description: 'Descrição da sessão 1',
      total_spots: 100,
      price: 1000,
    });

    expect(event.sections.size).toBe(1);
    expect(event.total_spots).toBe(100);

    const [section] = event.sections;

    expect(section.spots.size).toBe(100);

    // const spot = EventSpot.create();

    // section.spots.add(spot);

    // console.dir(event.toJSON(), { depth: 10 });

    // não é valido
    // customer = new Customer({
    //   id: '123', new CustomerId() || new CustomerId('')
    //   name: 'João',
    //   cpf: '99346413050',
    // });
  });

  test('deve publicar todos os itens do evento', () => {
    const event = Event.create({
      name: 'Evento 1',
      description: 'Descrição do evento 1',
      date: new Date(),
      partner_id: new PartnerId(),
    });

    event.addSection({
      name: 'Sessão 1',
      description: 'Descrição da sessão 1',
      total_spots: 100,
      price: 1000,
    });

    event.addSection({
      name: 'Sessão 2',
      description: 'Descrição da sessão 2',
      total_spots: 1000,
      price: 50,
    });

    event.publishAll();

    expect(event.is_published).toBe(true);

    const [section1, section2] = event.sections.values();
    expect(section1.is_published).toBe(true);
    expect(section2.is_published).toBe(true);

    [...section1.spots, ...section2.spots].forEach((spot) => {
      expect(spot.is_published).toBe(true);
    });
  });
  describe('liberação de lugar', () => {
    function makePublishedEvent() {
      const event = Event.create({
        name: 'Evento 1',
        description: 'Descrição do evento 1',
        date: new Date(),
        partner_id: new PartnerId(),
      });
      event.addSection({
        name: 'Sessão 1',
        description: 'Descrição da sessão 1',
        total_spots: 2,
        price: 100,
      });
      event.publishAll();
      event.clearEvents();
      return event;
    }

    test('deve devolver o lugar reservado descendo a cadeia até o spot', () => {
      const event = makePublishedEvent();
      const [section] = event.sections;
      const [spot] = section.spots;
      event.markSpotAsReserved({ section_id: section.id, spot_id: spot.id });
      expect(spot.is_reserved).toBe(true);
      event.clearEvents();

      event.markSpotAsAvailable(spot.id);

      expect(spot.is_reserved).toBe(false);
    });

    test('deve registrar o EventSpotReleased com event_id, section_id e spot_id', () => {
      const event = makePublishedEvent();
      const [section] = event.sections;
      const [spot] = section.spots;
      event.markSpotAsReserved({ section_id: section.id, spot_id: spot.id });
      event.clearEvents();

      event.markSpotAsAvailable(spot.id);

      const [domainEvent] = [...event.events];
      expect(domainEvent).toBeInstanceOf(EventSpotReleased);
      expect((domainEvent as EventSpotReleased).event_id).toEqual(event.id);
      expect((domainEvent as EventSpotReleased).section_id).toEqual(section.id);
      expect((domainEvent as EventSpotReleased).spot_id).toEqual(spot.id);
    });

    test('deve lançar erro quando o spot não pertence a nenhuma seção', () => {
      const event = makePublishedEvent();

      expect(() => event.markSpotAsAvailable(new EventSpotId())).toThrow(
        'Spot not found',
      );
      expect(event.events.size).toBe(0);
    });
  });
  describe('esgotamento da seção', () => {
    function makePublishedEvent(total_spots: number) {
      const event = Event.create({
        name: 'Evento 1',
        description: 'Descrição do evento 1',
        date: new Date(),
        partner_id: new PartnerId(),
      });
      event.addSection({
        name: 'Sessão 1',
        description: 'Descrição da sessão 1',
        total_spots,
        price: 100,
      });
      event.publishAll();
      event.clearEvents();
      return event;
    }

    test('não está esgotada enquanto houver lugar disponível para reserva', () => {
      const event = makePublishedEvent(2);
      const [section] = event.sections;
      const [spot] = section.spots;
      event.markSpotAsReserved({ section_id: section.id, spot_id: spot.id });

      expect(section.isSoldOut()).toBe(false);
    });

    test('está esgotada quando nenhum lugar está disponível para reserva', () => {
      const event = makePublishedEvent(1);
      const [section] = event.sections;
      const [spot] = section.spots;
      event.markSpotAsReserved({ section_id: section.id, spot_id: spot.id });

      expect(section.isSoldOut()).toBe(true);
    });

    test('volta a não estar esgotada quando o lugar é devolvido', () => {
      const event = makePublishedEvent(1);
      const [section] = event.sections;
      const [spot] = section.spots;
      event.markSpotAsReserved({ section_id: section.id, spot_id: spot.id });

      event.markSpotAsAvailable(spot.id);

      expect(section.isSoldOut()).toBe(false);
    });
  });
});
