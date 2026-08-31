# MBA Full Cycle - Domain Driven Design

Este repositório contém o código-fonte e material didático do curso de Domain Driven Design do MBA Full Cycle.

O projeto é feito com Nestjs, mas o conteúdo é independente de linguagem ou framework.

## Pré-requisitos

- Node.js 18+
- Docker

## Executar o projeto

Suba as aplicações MySQL, RabbitMQ e Redis:

```bash
docker-compose up -d
```

Instale as dependências do Node.js:

```bash
npm install
```

Prepare o banco (o projeto não traz migrações — o schema é criado a partir do
`mikro-orm.config.ts`):

```bash
npx mikro-orm schema:fresh --run
```

Suba a API principal (porta 3000):

```bash
npm run start:dev
```

E, em outro terminal, o app de e-mails (porta 3001):

```bash
npx nest start emails
```

Use o arquivo `api.http` como referência para fazer as requisições HTTP. Este arquivo funciona com a extensão [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client) do VSCode.

## Rodar a suíte de testes

```bash
npm test
```

Os testes de aplicação e de repositório rodam contra o MySQL real. Cada um recria o schema
com `orm.schema.refreshDatabase()` registrando apenas as entities daquele teste — e nenhum
deles registra o `StoredEventSchema`. Na prática, **rodar a suíte derruba a tabela
`stored_event`**, e sem ela a API responde 500 na primeira operação, porque o listener
wildcard tenta gravar o evento. Depois de rodar os testes, recrie o schema antes de subir a
API:

```bash
npx mikro-orm schema:fresh --run
```

O script `npm test` roda o Jest com `--runInBand`. Isso é necessário, não é preferência:
como todas as suítes de infraestrutura recriam o schema no mesmo banco, rodar em paralelo
produz deadlocks no MySQL.

Além da suíte, o fluxo completo da feature pode ser validado contra a API no ar com o
script `scripts/validar-fluxo.sh` — **execute-o no Git Bash** (é um script `bash`; no
PowerShell e no `cmd` ele não roda). Veja
[Roteiro de validação manual](#roteiro-de-validação-manual).

```bash
bash scripts/validar-fluxo.sh
```

## Feature: Lista de Espera de Ingressos

Um cliente cancela seu pedido; o lugar volta a ficar disponível; e, se houver fila de espera
naquela seção, o primeiro cliente da fila é notificado por e-mail. Nenhum comando conhece o
próximo: tudo acontece por reação a eventos de domínio.

### Artefatos de design estratégico

- [`docs/event-storming.excalidraw`](docs/event-storming.excalidraw) — o event storming da
  feature (abra em <https://excalidraw.com> ou pela extensão Excalidraw do VSCode)
- [`docs/event-storming.md`](docs/event-storming.md) — a leitura textual do mesmo desenho
- [`docs/linguagem-ubiqua.md`](docs/linguagem-ubiqua.md) — o glossário da feature

### Por que a `WaitingList` é um agregado separado do `Event`

O curso trata o tamanho do agregado como uma decisão sobre **limites de consistência
transacional**, não sobre proximidade conceitual: um agregado deve ser pequeno, coeso, e
conter apenas o que precisa ser consistente no mesmo instante. O `Event` já é uma raiz
pesada — carrega a coleção de `EventSection`, que por sua vez carrega todos os `EventSpot`,
e é ele quem protege as invariantes de publicação e de reserva de lugar. Colocar a fila de
espera dentro dessa mesma fronteira significaria carregar e travar todas as seções e lugares
de um evento para inserir uma linha na fila, e faria a raiz responder por duas
responsabilidades com ritmos completamente diferentes: a venda imediata, que precisa de
consistência forte para não vender o mesmo lugar duas vezes, e a espera, que é assíncrona
por natureza e tolera consistência eventual. Nada na lista de espera precisa ser decidido na
mesma transação que a reserva de um lugar — a única regra que atravessa as duas fronteiras
("liberou um lugar, avise o primeiro da fila") é justamente uma **política**, e política
entre agregados é exatamente o caso em que o curso manda usar evento de domínio em vez de
alargar a raiz. Por isso a `WaitingList` é uma raiz própria, identificada por `event_id` +
`section_id`, que referencia o evento e a seção **por ID, nunca por objeto**, e que só é
tocada por reação — a consistência entre as duas é eventual, garantida pela cadeia de
eventos.

### Entrar na fila

`POST /events/{event_id}/sections/{section_id}/waiting-list` executa dentro do
`ApplicationService.run(...)`, porque registra evento de domínio. O `WaitingListService`
valida o cliente (`Customer not found`), o evento (`Event not found`), a seção
(`Section not found`) e o esgotamento (`Section is not sold out`). A pergunta sobre
esgotamento é do domínio, não do application service: quem responde é
`EventSection.isSoldOut()`, derivando da disponibilidade dos próprios lugares — e nunca do
contador `total_spots_reserved`, que o fluxo de compra não mantém. A entrada nasce
`PENDING`, recebe a próxima `position` da fila, e o agregado registra o
`CustomerJoinedWaitingList`. **O application service da fila não notifica ninguém** — isso
é trabalho da política.

### A cadeia completa do cancelamento

Um único `POST /events/{event_id}/orders/{order_id}/cancel` faz cinco coisas acontecerem em
lugares diferentes do sistema:

1. O `OrdersController` chama `OrderService.cancel()`, que executa dentro de
   `ApplicationService.run(...)`. O `Order.cancel()` valida a invariante (um pedido já
   cancelado não pode ser cancelado de novo), muda o status para `CANCELLED` e registra o
   evento de domínio `OrderCancelled`, enriquecido com o `event_spot_id`. O agregado é
   devolvido ao Unit of Work com `orderRepo.add(order)` — é isso que faz o
   `ApplicationService` encontrá-lo e publicar seus eventos. **O comando não toca o agregado
   `Event` nem a `WaitingList`.**
2. O `OrderCancelledHandler` reage ao `OrderCancelled`. Ele conhece apenas o
   `event_spot_id`, então localiza o evento dono do lugar pela nova busca
   `IEventRepository.findByEventSpotId()`, implementada no `EventMysqlRepository`
   atravessando seções e lugares.
3. O agregado `Event` devolve o lugar com `markSpotAsAvailable(spot_id)`: ele mesmo descobre
   qual seção é dona do lugar, desce a cadeia `Event → EventSection → EventSpot` até
   `EventSpot.markAsAvailable()` e registra o `EventSpotReleased` com `event_id`,
   `section_id` e `spot_id`. O handler remove a `SpotReservation` daquele lugar — que é
   identificada pelo próprio `spot_id`, então o `findById` do contrato base já a encontra —
   e publica os eventos do agregado pelo `DomainEventManager`.
4. O `EventSpotReleasedHandler` reage ao `EventSpotReleased`. Carrega a `WaitingList` da
   seção (se a seção não tem fila, a reação termina sem efeito e sem erro), chama
   `WaitingList.offerSpotToNext(spot_id)` — que promove a primeira entrada `PENDING` para
   `NOTIFIED` e registra o `SpotOfferedToWaitingCustomer` — persiste o agregado e publica
   seus eventos de domínio **e** de integração.
5. O mapeamento registrado em `EventsModule.onModuleInit` converte o evento de domínio no
   `SpotOfferedToWaitingCustomerIntegrationEvent` e o enfileira na fila Bull
   `integration-events`. O `IntegrationEventsPublisher` o leva ao RabbitMQ (exchange
   `amq.direct`, routing key igual ao nome do evento de integração), onde o
   `ConsumerService` do `apps/emails` o consome com um `@RabbitSubscribe` próprio e loga o
   cliente e a seção.

Cada elo pode ser conferido pela tabela `stored_event`: ao final do fluxo ela contém
`CustomerJoinedWaitingList`, `OrderCancelled`, `EventSpotReleased` e
`SpotOfferedToWaitingCustomer`.

### Limitações do mecanismo base (mantidas como estão)

O enunciado pede que o mecanismo de eventos seja usado como está e que limitações sejam
documentadas em vez de contornadas. Duas valem registro:

- **Não há outbox.** O `ApplicationService` publica os eventos de domínio *antes* do commit
  e os de integração *depois*. Se o commit falhar, os handlers já rodaram; se o processo cair
  entre o commit e a publicação de integração, o e-mail se perde. O mecanismo é in-process e
  didático, e foi usado assim.
- **`registerForIntegrationEvent` escuta o nome do evento de domínio.** O
  `DomainEventManager.publishForIntegrationEvent()` emite usando
  `event.constructor.name` do evento de *domínio*. Portanto o mapeamento precisa ser
  registrado como `SpotOfferedToWaitingCustomer.name` — e não com o nome da classe do evento
  de integração, que é apenas a routing key no RabbitMQ.

### Roteiro de validação manual

O desafio inteiro se resume a uma frase: um único `POST` de cancelamento precisa fazer cinco
coisas acontecerem em lugares diferentes do sistema. Há duas formas de comprovar isso — o
script automatizado ou o `api.http`, passo a passo.

#### Opção 1 — o script `validar-fluxo.sh` (mais rápido)

> ⚠️ **Rode no Git Bash**, não no PowerShell nem no `cmd`. É um script `bash`, e nesses dois
> ele não executa. No Windows, o Git Bash vem junto com o Git; se preferir, o WSL também
> serve. No VSCode, abra um terminal e escolha **Git Bash** no seletor de shell.

Com a infraestrutura de pé e as duas aplicações no ar (veja os pré-requisitos logo abaixo):

```bash
bash scripts/validar-fluxo.sh
```

O script monta o cenário do zero — parceiro, clientes A e B, evento, seção com um único
lugar, `publish-all` —, esgota a seção com a compra do cliente A, coloca o cliente B na
fila, dispara **um único** `POST` de cancelamento e confere cada consequência, imprimindo
`[OK]` ou `[FALHOU]` por item. Ele também verifica que entrar na fila de uma seção com lugar
disponível é recusado. Saída esperada no final:

```
== 5. As cinco consequencias ==
  [OK]   o lugar voltou a ficar disponivel
  [OK]   a entrada do cliente B esta NOTIFIED
  [OK]   a trava de reserva foi removida
  [OK]   stored_event contem CustomerJoinedWaitingList
  [OK]   stored_event contem OrderCancelled
  [OK]   stored_event contem EventSpotReleased
  [OK]   stored_event contem SpotOfferedToWaitingCustomer

== RESULTADO: cadeia completa, todas as consequencias confirmadas ==
```

Pré-requisitos, cada um no seu terminal:

```bash
docker-compose up -d && npx mikro-orm schema:fresh --run
```

```bash
npm run start:dev
```

```bash
npx nest start emails
```

Falta um único item que o script não consegue verificar sozinho, porque acontece no outro
bounded context: **o terminal do `npx nest start emails` deve exibir**

```
ConsumerService.handleSpotOffered {
  email: 'abriu uma vaga na seção em que você está na lista de espera',
  customer_id: '…', event_id: '…', section_id: '…', spot_id: '…'
}
```

Se essa linha aparecer, a cadeia fechou inteira: do `POST /cancel` até o RabbitMQ do
contexto de e-mails.

Notas sobre o script: cada execução cria o próprio evento e a própria seção, então ele pode
rodar mais de uma vez sem recriar o schema — os clientes são reaproveitados pelo CPF, que é
único. Ele depende apenas de `curl`, `grep` e `sed` (o Git Bash já traz os três) e do
`docker`, usado só para conferir a tabela `stored_event` e a trava de reserva.

#### Opção 2 — passo a passo pelo `api.http`

Com o ambiente limpo (`docker-compose up -d`, `npx mikro-orm schema:fresh --run`, API e
`apps/emails` no ar), siga o `api.http` de cima para baixo: criar parceiro → criar os
clientes A e B → criar evento → criar seção com `total_spots: 1` → `publish-all` → comprar o
único lugar com o cliente A (a seção esgota) → entrar na fila com o cliente B → cancelar o
pedido do cliente A. Lembre de atualizar as variáveis (`@partner_id`, `@customer_id`,
`@customer_id_b`, `@event_id`, `@section_id`, `@spot_id`, `@order_id`) com os ids que cada
resposta devolve. Depois do cancelamento, confira as cinco consequências:

- o `GET` de spots da seção mostra o lugar disponível de novo (`reserved: false`);
- a consulta da fila mostra a entrada do cliente B como `NOTIFIED`;
- a tabela `spot_reservation` não tem mais a trava daquele lugar;
- o terminal do `apps/emails` exibe o log do evento de integração;
- `SELECT type_name FROM stored_event;` retorna as quatro linhas da cadeia.

Se for conferir a trava direto no MySQL, atenção: a coluna se chama `spot_id_id`, e não
`spot_id` — o MikroORM sufixa `_id` na FK `mapToPk` cujo nome de propriedade já termina em
`_id`.

```bash
docker exec mba-domain-driven-design-mysql-1 mysql -uroot -proot -D events -e "SELECT type_name FROM stored_event;"
```

Uma observação sobre as mensagens de erro: o projeto lança `Error` com string simples, sem
padronizar códigos HTTP — como o enunciado pede. Na prática o Nest responde `500` com
`"Internal server error"`, e a mensagem exata (`Section is not sold out`, `Order not
found`, …) aparece no terminal da API. Quem verifica as mensagens palavra por palavra são
os testes: `waiting-list.service.spec.ts` e `order-cancellation.spec.ts`.

## Professor

<a href="https://github.com/argentinaluiz">
    <img src="https://avatars.githubusercontent.com/u/4926329?v=4?s=100" width="100px;" alt=""/>
    <br />
    <sub>
        <b>Luiz Carlos</b>
    </sub>
</a>
