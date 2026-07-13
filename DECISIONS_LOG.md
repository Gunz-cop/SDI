# Registro de decisiones de SDI

Este registro cronológico resume decisiones relevantes. No reemplaza a los ADR: estos se usan para cambios arquitectónicos aprobados y con contexto completo.

| Fecha | Decisión | Nota |
| --- | --- | --- |
| 2026-07-10 | SDI 0.1 queda congelado para implementación. | La arquitectura es la fuente de verdad y cualquier cambio posterior requiere ADR. |
| 2026-07-10 | Google Indexing API sale del roadmap de SDI 0.1. | Los sitios actuales no muestran URLs elegibles; SDI 0.1 usa IndexNow como único destino live. |
| 2026-07-10 | SDI será un único paquete npm. | No habrá monorepo multipaquete ni sistema de plugins en 0.1. |
| 2026-07-10 | HouseGatitos será el proyecto piloto. | Es la base conductual incremental más madura y ejecuta discovery después del deploy. |
| 2026-07-10 | Se acepta OneDrive para el estado local con escritura atómica, backup y retry. | Es suficiente para 0.1; la persistencia remota se evalúa solo ante un caso real de runner efímero. |
| 2026-07-10 | Se recomienda migrar gradualmente los repositorios a `C:\Dev` fuera de OneDrive. | La recomendación no bloquea el desarrollo actual de SDI. |
| 2026-07-12 | La limpieza de locks stale es explícita y compare-and-delete. | La adquisición solo detecta e informa; `removeStaleLock` recibe una inspección stale, relee el archivo y solo lo elimina si el contenido no cambió. No limpia locks inválidos. La política usa PID local verificable o 30 minutos desde `startedAt`, con reloj/PID inyectables para pruebas. En Etapa 3 solo la invocan pruebas; el orquestador de Etapa 5 requerirá confirmación o flag explícito. |
| 2026-07-12 | `PublishResult` distingue fallos de transporte de respuestas HTTP. | `BatchPublishResult` usa una unión discriminada: un status HTTP es numérico y no admite `failure`; sin respuesta HTTP, `status` es `null` y exige `failure` (`timeout`, `network` o `aborted`). Véase ADR-0001. |
| 2026-07-12 | El destino IndexNow rechaza ChangeSets contradictorios antes de tocar la red. | No deduplica silenciosamente: una URL repetida, presente en varias categorías o modificada con URL distinta en `before`/`after` viola el contrato del core y aborta la publicación. |
| 2026-07-12 | El reporte usa contratos cerrados y redacción previa al writer. | `Diagnostic` contiene solo `code` y `message`; `RedactedConfig` refleja la configuración efectiva no sensible con forma explícita. El runner redacta y construye el reporte; `jsonReport.ts` valida invariantes locales, serializa determinísticamente y persiste con temp + rename, sin backup ni redactor recursivo. |
| 2026-07-12 | La configuración 0.1 usa un módulo MJS único, defaults mínimos y compatibilidad legacy acotada. | `siteId`, origin, source paths y trailing-slash son explícitos; state/report/fallback/keyEnv tienen defaults. El loader es independiente del modo, resuelve rutas y key opcional, y solo conserva overrides `SDI_SITE_URL`, `SDI_DIST_DIR` y `SDI_STATE_PATH`. Live valida IndexNow/key antes de efectos. |
| 2026-07-12 | Etapa 5 tendrá una única puerta de diseño del runner después de 5.0. | Antes de implementar `run.ts` se cerrarán juntos métricas de Source, first run, guardas, diagnósticos, reporte de force y orden de fallos; se evita tanto anticiparlos en config como detener cada subetapa por separado. |
