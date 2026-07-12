# ADR-0001: Representar fallos de transporte en resultados de IndexNow

- **Estado:** aceptado
- **Fecha:** 2026-07-12

## Contexto

El contrato inicial de `PublishResult` exigía `status: number` para cada batch. Un timeout, fallo DNS, TLS, conexión rechazada o cancelación no produce una respuesta HTTP, por lo que no existe un status que pueda representarlo sin inventar información.

## Decisión

`BatchPublishResult` será una unión discriminada. La variante HTTP contiene `status: number` y no admite `failure`. La variante de transporte contiene `status: null` y exige `failure: "timeout" | "network" | "aborted"`. `attempts` representa el total de intentos del batch.

`PublishResult.accepted` solo será `true` si todos los batches terminan en HTTP 200 o 202. `submittedUrls` contará las URLs de batches intentados al menos una vez, sin multiplicarlas por retries; los batches omitidos por fail-fast no se incluirán.

## Alternativas descartadas

- **`status: 0`:** confundiría un valor centinela con un código HTTP y perdería la distinción entre timeout, red y cancelación.
- **Solo excepciones:** impediría que el resultado final describa los batches ya intentados y sus intentos cuando un publish termine de forma parcial.

## Consecuencias

La corrección solo define el contrato de la Etapa 4. No añade `fetch`, batching, retries ni validación runtime. La clasificación concreta de errores se implementará en 4.2. El futuro `run.ts` podrá usar `accepted` para decidir el guardado del state, mientras conserva detalle suficiente para el reporte sin introducir resultados por destino ni outbox.

## Referencias

- `docs/SDI_PRODUCT_ARCHITECTURE.md`, §§11 y 16.
- `DECISIONS_LOG.md`, decisión del 2026-07-12.
