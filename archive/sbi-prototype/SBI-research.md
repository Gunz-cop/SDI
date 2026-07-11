# SBI / SDI Research

Fecha: 2026-07-03

## Proyectos revisados

- `C:\Users\grcx1\OneDrive\Documentos\Proyectos\CuidaTuPerroViejo`
- `C:\Users\grcx1\OneDrive\Documentos\Proyectos\HouseGatitos`
- `C:\Users\grcx1\OneDrive\Documentos\Proyectos\RuletaWeb`
- `C:\Users\grcx1\OneDrive\Documentos\Proyectos\ruleta-app`
- `C:\Users\grcx1\OneDrive\Documentos\Proyectos\vete\veterinarias-cr`

No encontré carpetas con nombre `Benten`, `Descargas IA`, `DescargasIA` o variantes claras dentro de `C:\Users\grcx1\OneDrive\Documentos\Proyectos` ni en una búsqueda más amplia bajo `C:\Users\grcx1\OneDrive\Documentos`.

## Qué existe hoy

### 1. Base más madura: `CuidaTuPerroViejo` y `HouseGatitos`

Ambos proyectos comparten una librería `lib/discovery` que ya funciona como un embrión de producto:

- runner principal: `lib/discovery/run.ts`
- extracción de URLs del build Astro: `lib/discovery/astro/getAstroUrls.ts`
- adaptador Google Indexing API: `lib/discovery/astro/googleAdapter.ts`
- adaptador IndexNow: `lib/discovery/astro/indexNowAdapter.ts`
- motor de cambios/envíos: `lib/discovery/core/engine.ts`
- persistencia local: `lib/discovery/core/fileStateAdapter.ts`
- archivos de estado: `lib/discovery/state/sdi-state.json`, `sdi-manifest.json`, `sdi-submissions.json`

Pruebas directas de uso:

- `CuidaTuPerroViejo` ejecuta SBI automáticamente con `postbuild` y manualmente con `sdi:run` en `package.json`.
- El README de `CuidaTuPerroViejo` documenta que el sistema detecta URLs nuevas/modificadas, usa Google + IndexNow y lee credenciales desde `.env`.

### 2. Variante más simple: `RuletaWeb`

`RuletaWeb` no usa `lib/discovery`. Tiene un script aparte `scripts/google-indexing.js` que:

- lee `dist/sitemap-0.xml`
- carga credenciales desde `.env`, `INDEXING_SERVICE_ACCOUNT_JSON` o `service-account.json`
- genera un JWT sin dependencias para autenticarse con Google
- envía todas las URLs a Google Indexing API
- tiene modo `--dry-run`

Esto parece una versión previa o paralela del producto, útil como referencia para compatibilidad.

### 3. Otra variante simple: `vete/veterinarias-cr`

`veterinarias-cr` repite casi exactamente el patrón de `RuletaWeb`:

- comando `indexing`: `node scripts/google-indexing.js`
- comando `indexing:dry`: `node scripts/google-indexing.js --dry-run`
- build normal separado del script de indexación
- script centrado solo en Google Indexing API
- sin motor incremental, sin `lib/discovery`, sin adaptadores y sin estado histórico estructurado

Detalles adicionales:

- su `build` corre `node scripts/shorten-links.js && astro build`
- el script de Google también desactiva TLS con `NODE_TLS_REJECT_UNAUTHORIZED = '0'`
- en la carpeta hay `.env` y `.env.example`, pero el `.env.example` no documenta variables de indexación; solo `LINKZIP_API_KEY`

Esto refuerza la hipótesis de que existieron al menos dos ramas de evolución:

- una línea "simple" basada en `google-indexing.js`
- una línea más madura basada en `lib/discovery`

### 4. Sin relación directa: `ruleta-app`

`ruleta-app` es React/Vite y no contiene código de indexación.

## Cómo funciona SBI hoy

### Flujo actual

1. El sitio hace build.
2. SBI lee `.env` manualmente.
3. Obtiene `siteUrl`, `distDir` y rutas de estado desde variables `SDI_*` o defaults.
4. Extrae URLs desde `dist/sitemap-0.xml` o, si falta, escanea HTML en `dist`.
5. Calcula hash del HTML compilado por URL.
6. Compara contra `sdi-state.json` y `sdi-manifest.json`.
7. Detecta URLs nuevas, modificadas y borradas.
8. Envía URLs nuevas/modificadas a los destinos configurados.
9. Guarda estado actualizado y un log histórico de envíos.

### Variables/configuración detectadas

- `SDI_SITE_URL`
- `SDI_DIST_DIR`
- `SDI_STATE_PATH`
- `SDI_MANIFEST_PATH`
- `SDI_LOG_PATH`
- `INDEXNOW_KEY`
- `INDEXNOW_HOST`
- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `SDI_FORCE_SUBMIT` (solo en la variante de `HouseGatitos`)
- `INDEXING_SERVICE_ACCOUNT_JSON` (solo en scripts tipo `RuletaWeb`)

### Persistencia detectada

- `sdi-manifest.json`: lista plana de URLs presentes en la última corrida.
- `sdi-state.json`: hash y `lastmod` por URL.
- `sdi-submissions.json`: historial de envíos con fecha, destinos y errores.

## Diferencias importantes entre implementaciones

### `CuidaTuPerroViejo`

- Marca la URL como procesada en `state` incluso si fallan destinos.
- No tiene concepto de destinos opcionales.
- Si Google falla, la URL igual puede quedar como "ya enviada".

### `HouseGatitos`

- Mejora el motor con `forceSubmit`.
- Introduce `optionalDestinations`.
- Solo persiste el estado si todos los destinos requeridos tuvieron éxito.
- En `run.ts`, Google está tratado como opcional con `optionalDestinations: ['google']`.
- Usa `scripts/discovery-runner.mjs` para ejecutar `tsx` con `--use-system-ca`.

### `RuletaWeb`

- No detecta cambios; envía todo el sitemap.
- No lleva historial estructurado ni estado incremental.
- Solo trabaja con Google.
- Tiene `dry-run` útil para un futuro producto.

### `vete/veterinarias-cr`

- Es esencialmente la misma familia que `RuletaWeb`.
- También envía todas las URLs del sitemap a Google.
- Tampoco tiene estado incremental ni soporte IndexNow.
- Confirma que el script `google-indexing.js` fue reutilizado al menos en dos proyectos distintos.

## Hallazgos y riesgos

### Fortalezas reutilizables

- La arquitectura por adaptadores ya existe.
- El motor incremental ya existe.
- El formato de logs ya da una base para UI, auditoría y troubleshooting.
- El escaneo de Astro y fallback por carpetas permite soportar más de un tipo de salida estática.

### Riesgos técnicos

- Google Indexing API está marcada como experimental y restringida por Google para tipos concretos de contenido. No es una integración general confiable para blogs/sitios comunes.
- El hash se calcula sobre HTML compilado. Cambios no funcionales del build pueden disparar falsos positivos.
- Hoy todo es file-based local. No sirve bien para multiusuario, colas, concurrencia ni ejecución remota.
- El loader de `.env` está duplicado en varias implementaciones.
- El script `google-indexing.js` está duplicado entre `RuletaWeb` y `vete/veterinarias-cr`.
- No hay panel, autenticación, colas, retries, rate limiting ni gestión segura de secretos.
- `RuletaWeb` y `vete/veterinarias-cr` desactivan validación TLS con `NODE_TLS_REJECT_UNAUTHORIZED = '0'`, lo cual no debería pasar a producto.

### Riesgos de producto

- Si esto se vende como "indexación garantizada", sería una promesa riesgosa.
- El valor real parece más "descubrimiento y envío automatizado" que "indexación asegurada".
- Google probablemente debería presentarse como conector opcional/experimental, no como el core del producto.

## Qué necesita el producto web

### Núcleo reutilizable

- Extraer `lib/discovery` a un paquete independiente.
- Unificar el runner de `HouseGatitos` como base canónica.
- Convertir la persistencia de archivos en una interfaz con adaptadores:
  - local file
  - base de datos
  - almacenamiento por proyecto

### Modelo mínimo del producto

- Proyecto/Sitio
- URL descubierta
- Snapshot/hash
- Destino de envío
- Submission attempt
- Secretos/credenciales por sitio
- Historial y estado actual

### Funciones mínimas del MVP

- Crear un sitio y definir `siteUrl`.
- Elegir fuente de URLs:
  - sitemap remoto
  - upload de sitemap
  - directorio build
  - integración Git/build
- Detectar cambios incrementalmente.
- Ejecutar envío manual y programado.
- Ver resultados por URL y por destino.
- Reintentos selectivos.
- Modo dry run.
- Marcar destinos como requeridos u opcionales.

### Conectores iniciales recomendados

- IndexNow
- Google Indexing API como experimental
- Futuro: Bing Webmaster, sitemap ping, webhooks, Search Console helpers

### Seguridad/operación

- Secret manager
- cifrado de credenciales
- colas
- retries con backoff
- logs estructurados
- control de cuota por destino
- auditoría por usuario/proyecto

## Recomendación de dirección

La mejor base no es `RuletaWeb`, sino la combinación:

- motor de `HouseGatitos` como base principal
- compatibilidad de credenciales y `dry-run` de `RuletaWeb`
- patrón reutilizado en `vete/veterinarias-cr`, porque confirma que esa interfaz simple ya se usó en más de un proyecto
- documentación de uso de `CuidaTuPerroViejo`

## Siguiente paso sugerido

Antes de construir la web, conviene hacer esto:

1. Consolidar una sola versión canónica de SBI en este repo `SDI`.
2. Convertirla en paquete reusable y CLI.
3. Definir el modelo de datos del panel web.
4. Decidir si el producto será:
   - SaaS multi-sitio
   - herramienta self-hosted
   - dashboard local + CLI

## Referencias clave

- `C:\Users\grcx1\OneDrive\Documentos\Proyectos\CuidaTuPerroViejo\README.md`
- `C:\Users\grcx1\OneDrive\Documentos\Proyectos\CuidaTuPerroViejo\package.json`
- `C:\Users\grcx1\OneDrive\Documentos\Proyectos\CuidaTuPerroViejo\lib\discovery\run.ts`
- `C:\Users\grcx1\OneDrive\Documentos\Proyectos\CuidaTuPerroViejo\lib\discovery\core\engine.ts`
- `C:\Users\grcx1\OneDrive\Documentos\Proyectos\HouseGatitos\lib\discovery\core\engine.ts`
- `C:\Users\grcx1\OneDrive\Documentos\Proyectos\HouseGatitos\scripts\discovery-runner.mjs`
- `C:\Users\grcx1\OneDrive\Documentos\Proyectos\RuletaWeb\package.json`
- `C:\Users\grcx1\OneDrive\Documentos\Proyectos\RuletaWeb\scripts\google-indexing.js`
- `C:\Users\grcx1\OneDrive\Documentos\Proyectos\vete\veterinarias-cr\package.json`
- `C:\Users\grcx1\OneDrive\Documentos\Proyectos\vete\veterinarias-cr\scripts\google-indexing.js`
