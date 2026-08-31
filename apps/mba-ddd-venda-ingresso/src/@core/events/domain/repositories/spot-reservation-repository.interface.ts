import { IRepository } from '../../../common/domain/repository-interface';
import { SpotReservation } from '../entities/spot-reservation.entity';

// A SpotReservation é identificada pelo spot_id, então o findById do contrato
// base já resolve a busca pela trava de um lugar.
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ISpotReservationRepository
  extends IRepository<SpotReservation> {}
