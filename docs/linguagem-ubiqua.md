# Linguagem Ubíqua — Lista de Espera de Ingressos

Glossário da feature. Cada termo é o nome que o time usa na conversa **e** o nome que
aparece no código: classes, métodos, eventos e mensagens de erro seguem estes termos.

| Termo (negócio) | Nome no código |
| --- | --- |
| Lista de Espera | `WaitingList` |
| Entrada na fila | `WaitingListEntry` |
| Ordem de chegada | `WaitingListEntry.position` / `WaitingList.entries_by_arrival` |
| Entrada Pendente | `WaitingListEntryStatus.PENDING` |
| Entrada Notificada | `WaitingListEntryStatus.NOTIFIED` |
| Entrar na Lista de Espera | `WaitingListService.join()` / `WaitingList.addEntry()` |
| Oferecer o Lugar ao Próximo | `WaitingList.offerSpotToNext()` |
| Liberação de Lugar | `Event.markSpotAsAvailable()` / `EventSpotReleased` |
| Trava de Reserva | `SpotReservation` (identificada pelo `spot_id`) |
| Seção Esgotada | `EventSection.isSoldOut()` |
| Cancelamento de Pedido | `Order.cancel()` / `OrderCancelled` |

---

**Lista de Espera (`WaitingList`)** — Fila de clientes que aguardam a abertura de uma vaga
em uma seção esgotada. Existe uma lista por evento + seção, e ela é um agregado próprio,
fora do `Event`.

**Entrada (`WaitingListEntry`)** — Cada cliente na fila. É entidade filha da `WaitingList`,
nunca existe fora dela, e guarda o cliente, o status e a ordem de chegada.

**Ordem de Chegada (`position`)** — Posição sequencial que a entrada recebe ao ser criada.
É o que define quem é "o primeiro da fila", tanto em memória quanto ao recarregar do banco.

**Entrada Pendente (`PENDING`)** — Estado inicial da entrada: o cliente está esperando e
ainda não foi avisado de nenhuma vaga.

**Entrada Notificada (`NOTIFIED`)** — Estado da entrada depois que o cliente foi avisado de
uma vaga. Uma entrada notificada não é notificada de novo, e não bloqueia o mesmo cliente de
entrar na fila outra vez.

**Entrar na Lista de Espera** — Comando do cliente para reservar seu lugar na fila. Só é
aceito se a seção estiver esgotada e se o cliente ainda não tiver uma entrada pendente ali.

**Seção Esgotada (Sold Out)** — Seção em que nenhum lugar está disponível para reserva. A
pergunta é respondida pelo próprio agregado, em `EventSection.isSoldOut()`, e derivada da
disponibilidade dos lugares — nunca do contador `total_spots_reserved`, que o fluxo de
compra não mantém.

**Cancelamento de Pedido (`OrderCancelled`)** — Evento de domínio que o `Order` registra ao
ser cancelado. Carrega o `event_spot_id` porque é essa informação que as reações precisam
para achar o lugar. É o primeiro elo da cadeia.

**Liberação de Lugar (`EventSpotReleased`)** — Evento de domínio que o agregado `Event`
registra quando devolve um lugar à disponibilidade. Carrega `event_id`, `section_id` e
`spot_id`.

**Trava de Reserva (`SpotReservation`)** — Registro que bloqueia um lugar para um cliente
durante a compra. É identificada pelo próprio `spot_id`, então é buscada pelo `findById` do
contrato de repositório. Ao liberar o lugar, a trava é removida.

**Oferta de Vaga (`SpotOfferedToWaitingCustomer`)** — Evento de domínio registrado quando a
primeira entrada pendente da fila é promovida a notificada. Carrega `customer_id`,
`event_id`, `section_id` e `spot_id`.

**Política (Lugar liberado → Notificar o primeiro da fila)** — A regra que fecha o ciclo:
sempre que um lugar é liberado, o primeiro da fila daquela seção é avisado. Vive no
`EventSpotReleasedHandler`, nunca dentro de um comando. A política **apenas notifica**: o
cliente avisado compra pelo fluxo normal, sem reserva, sem prioridade e sem prazo de
validade da oferta.

**Notificação de Vaga (`SpotOfferedToWaitingCustomerIntegrationEvent`)** — Evento de
integração que leva a oferta para fora do contexto de Venda de Ingressos, via fila Bull e
RabbitMQ, até o contexto de Emails (`apps/emails`).
