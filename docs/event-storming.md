# Event Storming — Lista de Espera de Ingressos

O diagrama está em [`event-storming.excalidraw`](event-storming.excalidraw) — abra em
<https://excalidraw.com> (menu → *Open*) ou pela extensão *Excalidraw* do VSCode. Este
arquivo é a leitura textual do mesmo desenho.

## Legenda das cores

| Cor | Significado |
| --- | --- |
| 🟡 Amarelo | Ator / Agregado |
| 🔵 Azul | Comando |
| 🟠 Laranja | Evento de domínio |
| 🟣 Lilás | Política (handler que reage a um evento) |
| 🟪 Roxo | Evento de integração |
| 🔴 Vermelho | Fronteira do sistema / contexto externo |

## Fluxo 1 — Entrar na lista de espera

```
[Cliente] → [Entrar na Lista de Espera] → [WaitingList] → [CustomerJoinedWaitingList]
```

Invariantes verificadas no caminho: a seção precisa estar esgotada — pergunta respondida
pelo próprio agregado, em `EventSection.isSoldOut()` (`Section is not sold out`) — e o
cliente não pode ter uma entrada `PENDING` naquela fila (`Customer already in waiting
list`). A entrada nasce `PENDING`, na ordem de chegada.

## Fluxo 2 — Cancelamento e a cadeia de reações

```
[Cliente] → [Cancelar Pedido] → [Order] → [OrderCancelled (+ event_spot_id)]
                                                    │
                              (política) OrderCancelledHandler
                                                    ↓
                        [Event.markSpotAsAvailable()] → [EventSpotReleased]
                        [SpotReservation removida]            │
                                                              │
                       (política) EventSpotReleasedHandler ───┘
                                                    ↓
                    [WaitingList.offerSpotToNext()] → [SpotOfferedToWaitingCustomer]
                                                              │
                                                              ↓
                          [SpotOfferedToWaitingCustomerIntegrationEvent]
                                                              │
                        fila Bull "integration-events" → RabbitMQ (amq.direct)
                                                              ↓
                              ╎ fronteira do contexto de Emails ╎
                                                              ↓
                              [apps/emails · ConsumerService @RabbitSubscribe]
```

O comando de cancelamento **não** libera o lugar nem promove a fila: ele cancela o pedido e
registra o evento. Tudo o que vem depois é reação.

## Pontos de atenção que o desenho registra

- O cancelamento roda dentro do `ApplicationService.run(...)`. Só por esse caminho os
  eventos do agregado são publicados e gravados na tabela `stored_event`.
- Cada handler publica os eventos do agregado que ele mesmo manipulou — o
  `DomainEventManager` não descobre isso sozinho. Sem essa chamada, a corrente para no
  primeiro elo.
- `EventSpotReleased` sem fila na seção (ou com fila sem entrada `PENDING`) termina sem
  efeito e sem erro.
- A política **apenas notifica**: quem foi avisado compra pelo fluxo normal, sem reserva,
  sem prioridade e sem expiração da oferta.
