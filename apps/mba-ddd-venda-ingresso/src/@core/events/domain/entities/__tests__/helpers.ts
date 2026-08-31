import { MikroORM } from '@mikro-orm/core';
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
} from '../../../infra/db/schemas';

export function initOrm() {
  beforeAll(async () => {
    await MikroORM.init(
      {
        allowGlobalContext: true,
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
        type: 'mysql',
        dbName: 'fake',
      },
      false,
    );
  });
}
