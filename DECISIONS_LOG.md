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
