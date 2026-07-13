# Changelog

Todos los cambios relevantes de SDI se documentan en este archivo.

El formato se basa en Keep a Changelog y el proyecto sigue Semantic Versioning.

Se debe actualizar `Unreleased` cuando un cambio aprobado modifica el comportamiento, los contratos publicos o internos relevantes, las integraciones, las correcciones visibles o cualquier decision implementada que afecte el estado real del producto. No se usa para ideas futuras ni para trabajo descartado.

## [Unreleased]

### Added

- Cargador interno de `sdi.config.mjs` con validación estricta, defaults documentados, rutas resueltas y compatibilidad limitada con overrides legacy.
- Contrato interno `ResolvedConfig`, error `SdiConfigError` y conversión explícita a `RedactedConfig` que no expone la clave de IndexNow.
- Runner read-only para `dry-run`: lock, state, discovery Astro con metadata, fingerprint, comparación y reporte JSON sin publicar ni guardar state.
- Runner de `baseline` confirmado para guardar el inventario inicial sin red y sin reemplazar un state existente.
- Runner live que publica cambios mediante IndexNow y avanza state únicamente tras aceptación completa, con force y guarda de large delete.
- Contrato `RunOutcome` para separar el resultado funcional del runner de la futura consola y los exit codes del CLI.
- Cliente interno de IndexNow que publica URLs creadas, actualizadas y eliminadas en batches de hasta 1.000 URLs.
- Pruebas del payload JSON de IndexNow, batches y fail-fast HTTP.
- Reintentos acotados de IndexNow para timeout, transporte y respuestas HTTP transitorias, con `Retry-After` y backoff con jitter.
- Contratos y writer atómico del reporte JSON de la última ejecución.
- Contratos principales del core:
  - `UrlRecord`
  - `DiscoveredResource`
  - `DiscoveryState`
  - `ChangeSet`
  - `Source`
  - `StateStore`
  - `Destination`
  - `PublishResult`
- Normalizacion de URLs con politicas `preserve`, `always` y `never`.
- Fingerprint SHA-256 sobre los bytes crudos del HTML compilado.
- Comparador puro para recursos creados, actualizados, sin cambios y eliminados.
- Orden determinista por URL en todas las colecciones de `ChangeSet`.
- Pruebas unitarias del core.

### Changed

- `PublishResult.batches` ahora usa `BatchPublishResult`, una unión discriminada que representa de forma explícita respuestas HTTP y fallos de transporte sin respuesta.

### Fixed

- El runner conserva la metadata real de discovery para inventarios vacíos y reporta fallos de IO del source Astro como errores operativos seguros.
- El cargador rechaza rutas de configuración que no terminen exactamente en `.mjs` antes de intentar importarlas.
- Se completaron los contratos internos omitidos inicialmente en la implementacion de la Etapa 2.

## [0.1.0] - Por publicar

Primera version publica de SDI.
