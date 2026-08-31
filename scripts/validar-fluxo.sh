#!/usr/bin/env bash
#
# Roteiro de validacao manual da feature de Lista de Espera.
#
# Reproduz o fluxo completo do enunciado e confere as cinco consequencias de um
# unico POST de cancelamento. Equivale a percorrer o api.http de cima para baixo.
#
# >> RODE NO GIT BASH <<  (ou WSL). Este e um script bash: no PowerShell e no
# cmd ele nao executa. No Windows o Git Bash vem junto com o Git; no VSCode,
# escolha "Git Bash" no seletor de shell do terminal.
#
# Depende apenas de curl, grep e sed (o Git Bash ja traz os tres) e do docker,
# usado so para conferir a tabela stored_event e a trava de reserva.
#
# Pre-requisitos (em outros terminais):
#   docker-compose up -d
#   npx mikro-orm schema:fresh --run
#   npm run start:dev        # API principal, porta 3000
#   npx nest start emails    # app de e-mails
#
# Uso: bash scripts/validar-fluxo.sh
#
# Cada execucao cria o proprio evento e a propria secao, entao o script pode
# rodar mais de uma vez sem recriar o schema.
#
set -e

API=${API:-http://localhost:3000}
MYSQL_CONTAINER=${MYSQL_CONTAINER:-mba-domain-driven-design-mysql-1}

# --- leitura de JSON sem depender de node/python/jq -------------------------

# Valor de uma chave string, no primeiro objeto encontrado.
json_str() {
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 \
    | sed "s/.*:[[:space:]]*\"\(.*\)\"$/\1/"
}

# Valor cru (booleano ou numero), no primeiro objeto encontrado.
json_raw() {
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*[^,}]*" | head -1 \
    | sed "s/.*:[[:space:]]*//"
}

# Id do cliente cujo cpf casa com o argumento, dentro de uma lista JSON.
customer_id_by_cpf() {
  sed 's/},{/}\n{/g' \
    | grep "\"cpf\"[[:space:]]*:[[:space:]]*\"$1\"" | head -1 \
    | json_str id
}

ok()  { echo "  [OK]   $1"; }
bad() { echo "  [FALHOU] $1"; FAILED=1; }
FAILED=0

# Sem a API no ar o curl falha em silencio, entao a checagem vem antes de tudo.
if ! curl -s -o /dev/null -m 5 "$API/partners"; then
  echo "ERRO: nao consegui falar com a API em $API"
  echo
  echo "Suba a infraestrutura e as duas aplicacoes, cada uma no seu terminal:"
  echo "  docker-compose up -d && npx mikro-orm schema:fresh --run"
  echo "  npm run start:dev        # API principal, porta 3000"
  echo "  npx nest start emails    # app de e-mails"
  exit 1
fi

if ! command -v docker > /dev/null; then
  echo "AVISO: docker nao esta no PATH deste shell."
  echo "       As checagens da stored_event e da trava de reserva vao falhar."
  echo
fi

# O CPF do Customer e unico, entao o script reaproveita o cliente se ele ja
# existir, e o roteiro pode rodar mais de uma vez sem recriar o schema.
ensure_customer() {
  local nome="$1" cpf="$2" digitos existente
  digitos=$(echo "$cpf" | tr -cd '0-9')
  existente=$(curl -s "$API/customers" | customer_id_by_cpf "$digitos")

  if [ -n "$existente" ]; then
    echo "$existente"
    return
  fi

  curl -s -X POST "$API/customers" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$nome\",\"cpf\":\"$cpf\"}" | json_str id
}

# --- 1. cenario ------------------------------------------------------------

echo "== 1. Cenario: parceiro, clientes A e B, evento com secao de 1 lugar =="
PARTNER=$(curl -s -X POST "$API/partners" -H 'Content-Type: application/json' \
  -d '{"name":"Partner 1"}' | json_str id)

CA=$(ensure_customer "Customer A" "592.110.870-74")
CB=$(ensure_customer "Customer B" "993.464.130-50")

EV=$(curl -s -X POST "$API/events" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Event 1\",\"description\":\"D\",\"date\":\"2020-01-01T00:00:00.000Z\",\"partner_id\":\"$PARTNER\"}" \
  | json_str id)

curl -s -X POST "$API/events/$EV/sections" -H 'Content-Type: application/json' \
  -d '{"name":"Section 1","description":"D","total_spots":1,"price":200}' > /dev/null
curl -s -X PUT "$API/events/$EV/publish-all" > /dev/null

SEC=$(curl -s "$API/events/$EV/sections" | json_str id)
SPOT=$(curl -s "$API/events/$EV/sections/$SEC/spots" | json_str id)
echo "  evento=$EV secao=$SEC lugar=$SPOT"

# --- 2. a secao esgota -----------------------------------------------------

echo
echo "== 2. Cliente A compra o unico lugar: a secao esgota =="
ORDER=$(curl -s -X POST "$API/events/$EV/orders" -H 'Content-Type: application/json' \
  -d "{\"customer_id\":\"$CA\",\"section_id\":\"$SEC\",\"spot_id\":\"$SPOT\",\"card_token\":\"tok_visa\"}" \
  | json_str id)
echo "  pedido=$ORDER"

# --- 3. entrar na fila -----------------------------------------------------

echo
echo "== 3. Cliente B entra na fila da secao esgotada =="
curl -s -X POST "$API/events/$EV/sections/$SEC/waiting-list" \
  -H 'Content-Type: application/json' -d "{\"customer_id\":\"$CB\"}"
echo
STATUS_ANTES=$(curl -s "$API/events/$EV/sections/$SEC/waiting-list" | json_str status)
if [ "$STATUS_ANTES" = "PENDING" ]; then
  ok "entrada criada como PENDING"
else
  bad "esperava PENDING, veio '$STATUS_ANTES'"
fi

echo
echo "== 3b. Nao deve aceitar entrar na fila de uma secao com lugar disponivel =="
EV2=$(curl -s -X POST "$API/events" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Event 2\",\"description\":\"D\",\"date\":\"2020-01-01T00:00:00.000Z\",\"partner_id\":\"$PARTNER\"}" \
  | json_str id)
curl -s -X POST "$API/events/$EV2/sections" -H 'Content-Type: application/json' \
  -d '{"name":"Section 2","description":"D","total_spots":2,"price":100}' > /dev/null
curl -s -X PUT "$API/events/$EV2/publish-all" > /dev/null
SEC2=$(curl -s "$API/events/$EV2/sections" | json_str id)

# O projeto lanca Error com string simples, entao o Nest responde 500 generico:
# a mensagem exata sai no terminal da API, nao no corpo da resposta.
HTTP=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$API/events/$EV2/sections/$SEC2/waiting-list" \
  -H 'Content-Type: application/json' -d "{\"customer_id\":\"$CB\"}")
FILA2=$(curl -s "$API/events/$EV2/sections/$SEC2/waiting-list")
if [ "$HTTP" = "500" ] && [ "$FILA2" = "[]" ]; then
  ok "recusou a entrada (a API loga 'Section is not sold out')"
else
  bad "esperava recusa e fila vazia; http=$HTTP fila=$FILA2"
fi

# --- 4. o unico comando ----------------------------------------------------

echo
echo "== 4. UM UNICO POST: cancelar o pedido do cliente A =="
curl -s -X POST "$API/events/$EV/orders/$ORDER/cancel"
echo
sleep 2

# --- 5. as consequencias ---------------------------------------------------

echo
echo "== 5. As cinco consequencias =="

RESERVED=$(curl -s "$API/events/$EV/sections/$SEC/spots" | json_raw reserved)
if [ "$RESERVED" = "false" ]; then
  ok "o lugar voltou a ficar disponivel"
else
  bad "o lugar continua reservado (reserved=$RESERVED)"
fi

STATUS_DEPOIS=$(curl -s "$API/events/$EV/sections/$SEC/waiting-list" | json_str status)
if [ "$STATUS_DEPOIS" = "NOTIFIED" ]; then
  ok "a entrada do cliente B esta NOTIFIED"
else
  bad "esperava NOTIFIED, veio '$STATUS_DEPOIS'"
fi

RESERVAS=$(docker exec "$MYSQL_CONTAINER" mysql -uroot -proot -D events -N -B \
  -e "SELECT COUNT(*) FROM spot_reservation WHERE spot_id_id='$SPOT';" 2>/dev/null || echo "?")
RESERVAS=$(echo "$RESERVAS" | tr -d '\r')
if [ "$RESERVAS" = "0" ]; then
  ok "a trava de reserva foi removida"
else
  bad "esperava 0 travas para o lugar, veio '$RESERVAS'"
fi

EVENTOS=$(docker exec "$MYSQL_CONTAINER" mysql -uroot -proot -D events -N -B \
  -e "SELECT type_name FROM stored_event;" 2>/dev/null || echo "")
for E in CustomerJoinedWaitingList OrderCancelled EventSpotReleased SpotOfferedToWaitingCustomer; do
  if echo "$EVENTOS" | grep -q "$E"; then
    ok "stored_event contem $E"
  else
    bad "stored_event NAO contem $E"
  fi
done

echo
echo "  Falta conferir a olho: o terminal do 'npx nest start emails' deve exibir"
echo "  a linha 'ConsumerService.handleSpotOffered' com o cliente e a secao."
echo

if [ "$FAILED" = "1" ]; then
  echo "== RESULTADO: alguma consequencia nao aconteceu =="
  exit 1
fi
echo "== RESULTADO: cadeia completa, todas as consequencias confirmadas =="
