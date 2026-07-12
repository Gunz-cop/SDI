# Changelog

Todos los cambios relevantes de SDI se documentan en este archivo.

El formato se basa en Keep a Changelog y el proyecto sigue Semantic Versioning.

Se debe actualizar `Unreleased` cuando un cambio aprobado modifica el comportamiento, los contratos publicos o internos relevantes, las integraciones, las correcciones visibles o cualquier decision implementada que afecte el estado real del producto. No se usa para ideas futuras ni para trabajo descartado.

## [Unreleased]

### Added

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

- Se completaron los contratos internos omitidos inicialmente en la implementacion de la Etapa 2.

## [0.1.0] - Por publicar

Primera version publica de SDI.
