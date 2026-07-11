# Diseño de la Etapa 2 — Core puro

**Estado:** listo para implementación  
**Etapa:** 2 de 6  
**Documento rector:** [SDI_PRODUCT_ARCHITECTURE.md](SDI_PRODUCT_ARCHITECTURE.md)  
**Alcance:** tipos mínimos, normalización URL, SHA-256 y comparación de snapshots

> Este documento detalla cómo implementar la Etapa 2 sin modificar la arquitectura congelada. Si existe una contradicción, prevalece `SDI_PRODUCT_ARCHITECTURE.md`.

## 1. Resultado esperado

Al terminar la etapa, SDI tendrá un núcleo determinista y sin efectos externos capaz de:

1. convertir una URL absoluta del sitio en su identidad canónica;
2. calcular una huella SHA-256 sobre bytes de HTML;
3. comparar dos inventarios de `UrlRecord`;
4. clasificar cada URL como `created`, `updated`, `unchanged` o `deleted`;
5. devolver todas las categorías ordenadas sin modificar los inputs.

La prueba central de cierre es:

```text
snapshot inicial → todas created
mismo snapshot por segunda vez → todas unchanged
```

## 2. Límite de la etapa

### Incluido

- Tipos usados directamente por el core puro.
- Normalización con `preserve|always|never`.
- Validación de URL absoluta, protocolo, credenciales y origin.
- Eliminación de fragmentos y conservación de query.
- SHA-256 `sha256-raw-html-v1` sobre `Uint8Array`.
- Comparación por URL normalizada + hash.
- Orden determinista y rechazo de URLs duplicadas.
- Pruebas unitarias exhaustivas de esas reglas.

### Fuera de alcance

- Lectura de sitemap, XML, archivos o directorios.
- Mapeo URL → archivo HTML.
- Estado JSON, validación legacy, backup, lock o escritura atómica.
- Config loader y `sdi.config.mjs`.
- CLI `run`, `baseline`, `dry-run` o `force`.
- IndexNow, `fetch`, retries o timeouts.
- Reportes, códigos operativos o guardas de inventario vacío/borrado masivo.
- Implementaciones de `Source`, `StateStore` o `Destination`.
- Nuevas dependencias npm de runtime.

Las guardas de empty source y large delete pertenecen a la orquestación de la Etapa 5. El comparator debe poder representar correctamente un inventario actual vacío; no debe aplicar políticas operativas.

## 3. Archivos exactos

```text
src/core/
├── types.ts
├── normalize.ts
├── fingerprint.ts
└── compare.ts

tests/core/
├── normalize.test.ts
├── fingerprint.test.ts
└── compare.test.ts
```

No se crea barrel `src/core/index.ts` ni `exports` público en esta etapa. Los tests importan módulos concretos usando extensiones `.js`, conforme a `NodeNext`.

`src/cli.ts` y `tests/cli.test.ts` no cambian: el CLI continúa siendo únicamente la fundación de la Etapa 1.

## 4. Tipos de dominio

`src/core/types.ts` contendrá solo tipos consumidos por esta etapa:

```ts
export type TrailingSlashPolicy = "preserve" | "always" | "never";

export interface NormalizeUrlOptions {
  siteUrl: string;
  trailingSlash: TrailingSlashPolicy;
}

export interface UrlRecord {
  url: string;
  hash: string;
  lastmod?: string;
}

export interface UpdatedUrl {
  before: UrlRecord;
  after: UrlRecord;
}

export interface ChangeSet {
  created: UrlRecord[];
  updated: UpdatedUrl[];
  unchanged: UrlRecord[];
  deleted: UrlRecord[];
}
```

Decisiones:

- `hash` permanece como `string`; el profile se fija en el módulo de fingerprint.
- `lastmod` es metadata y nunca participa en la decisión de cambio.
- No se añaden genéricos, branded types ni clases de dominio en 0.1.
- `DiscoveredResource`, `DiscoveryState` y contratos con efectos se incorporan en sus etapas, cuando exista código que los consuma.
- Las funciones aceptan inputs readonly, pero las interfaces serializables conservan arrays/objetos simples.

## 5. Normalización de URLs

### API

```ts
export function normalizeUrl(
  rawUrl: string,
  options: Readonly<NormalizeUrlOptions>,
): string;
```

### Algoritmo

1. Parsear `options.siteUrl` y `rawUrl` con la implementación WHATWG `URL` de Node.
2. Exigir `http:` o `https:` en ambas.
3. Rechazar username/password en la URL candidata.
4. Comparar `candidate.origin === site.origin`. Scheme, hostname y puerto forman parte del origin; `www` no se considera equivalente automáticamente.
5. Eliminar `hash`/fragment.
6. Aplicar la política al `pathname`:
   - `preserve`: no cambiar el slash que serializa `URL`;
   - `always`: añadir uno si la ruta no es `/` y no termina en `/`;
   - `never`: quitar todos los slash finales salvo en `/`.
7. Devolver `candidate.href`.

### Semántica congelada

- La raíz siempre termina en `/` para las tres políticas.
- La política se aplica también a rutas que parecen archivos; no hay heurística por extensión.
- Hostname se normaliza como lo hace WHATWG; el path conserva mayúsculas/minúsculas.
- Puertos por defecto se canonicalizan mediante `URL`.
- Query string se conserva en el mismo orden y con los mismos valores, sujeta a la serialización WHATWG.
- No se ordenan ni eliminan parámetros.
- No se transforma HTTP en HTTPS.
- No se eliminan `www`, `index.html`, parámetros de tracking ni dobles slash de contenido mediante reglas propias.
- Una URL relativa es inválida.
- Errores de parseo, protocolo, credenciales u origin usan `TypeError` con un mensaje descriptivo; no se diseña todavía una taxonomía pública de errores.

### Matriz mínima

| Caso | Input | Política | Resultado esperado |
|---|---|---|---|
| House | `https://housegatitos.com/gatos` | `always` | `https://housegatitos.com/gatos/` |
| House root | `https://housegatitos.com` | `always` | `https://housegatitos.com/` |
| Cuida | `https://cuidatuperroviejo.com/salud/` | `never` | `https://cuidatuperroviejo.com/salud` |
| Ruleta query | `https://decidelo.app/ruleta/?a=1&b=2#x` | `never` | `https://decidelo.app/ruleta?a=1&b=2` |
| Vet24 | `https://vet24cr.com/clinicas/san-jose` | `always` | `https://vet24cr.com/clinicas/san-jose/` |
| Preserve | `https://example.com/a/` | `preserve` | `https://example.com/a/` |

## 6. Fingerprint

### API

```ts
export const FINGERPRINT_PROFILE = "sha256-raw-html-v1" as const;

export function fingerprintHtml(content: Uint8Array): string;
```

### Reglas

- Usar `createHash("sha256")` de `node:crypto`.
- Hashear los bytes recibidos sin decodificar, normalizar whitespace ni transformar saltos de línea.
- Devolver 64 caracteres hexadecimales en minúscula.
- La función no lee archivos; la Etapa 3 entregará los bytes.
- Aceptar `Uint8Array` evita una decisión implícita de encoding. `Buffer` funciona por ser subtipo de `Uint8Array`.
- No incluir URL, `lastmod`, file path ni profile dentro del digest.

`FINGERPRINT_PROFILE` se almacenará en state durante la Etapa 3 para impedir comparaciones entre algoritmos incompatibles.

## 7. Comparación

### API

```ts
export function compareUrlRecords(
  previous: readonly UrlRecord[],
  current: readonly UrlRecord[],
): ChangeSet;
```

### Precondiciones

- Las URLs ya están normalizadas.
- Cada colección contiene como máximo un registro por URL.
- Los hashes ya fueron calculados.

El comparator comprobará duplicados para evitar que un `Map` sobrescriba datos silenciosamente. Cualquier URL duplicada en `previous` o `current` produce `TypeError`. La deduplicación y sus métricas pertenecen al source/orquestador posteriores.

### Algoritmo

1. Construir índices locales por `url`, sin modificar los arrays.
2. Recorrer `current`:
   - ausente en `previous` → `created`;
   - mismo hash → `unchanged`, usando el registro actual;
   - hash distinto → `updated` con `{before, after}`.
3. Recorrer `previous`; si no existe en `current` → `deleted`, usando el registro anterior.
4. Ordenar todas las categorías por URL usando comparación de code units, no locale del sistema.

### Invariantes

- Cada URL aparece exactamente en una categoría.
- `lastmod` distinto con hash idéntico produce `unchanged`.
- `updated.before` es el registro anterior y `updated.after` el actual.
- Un inventario anterior vacío clasifica todo como `created`.
- Un inventario actual vacío clasifica todo como `deleted`; bloquear ese caso es responsabilidad posterior.
- Inputs y objetos contenidos no se mutan.
- El resultado no depende del orden de entrada.
- El comparator no conoce `force`, dry-run, estado, destinos ni políticas de borrado.

## 8. Pruebas

### `normalize.test.ts`

Debe cubrir:

- las seis filas de la matriz anterior;
- fragment removal sin perder query;
- root para las tres políticas;
- archivo `.html` con `always`;
- path case-sensitive;
- puerto por defecto canonicalizado;
- query con parámetros repetidos y orden preservado;
- rechazo de relativa, URL malformada, `ftp:`, credenciales y origin externo;
- `www` vs apex como origins diferentes;
- options no mutadas.

### `fingerprint.test.ts`

Debe cubrir:

- vector conocido de bytes vacíos;
- vector conocido de un HTML ASCII corto;
- determinismo;
- un byte diferente produce hash distinto;
- bytes UTF-8 no ASCII;
- formato `/^[a-f0-9]{64}$/`;
- constante exacta `sha256-raw-html-v1`.

Los hashes esperados deben ser literales calculados de forma independiente, no usando la función bajo prueba para generar el expected.

Vectores aprobados para evitar interpretaciones de encoding:

| Bytes UTF-8 de | SHA-256 esperado |
|---|---|
| cadena vacía | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `<html></html>` | `b633a587c652d02386c4f16f8c6f6aab7352d97f16367c3c40576214372dd628` |
| `<p>café</p>` | `748ae391a17054e980aaf0dcf88abc22a3ca9ff31c0494531dddb4e31b6bd293` |

### `compare.test.ts`

Debe cubrir:

- primer snapshot: todo `created`;
- segundo snapshot idéntico: todo `unchanged`;
- caso mixto con las cuatro categorías;
- `lastmod` únicamente modificado: `unchanged`;
- outputs ordenados desde inputs desordenados;
- `before`/`after` correctos;
- previous/current vacíos;
- duplicado en previous y duplicado en current;
- inputs sin mutación.

No se usan snapshots de Vitest para estructuras pequeñas; assertions explícitas hacen visibles las reglas de negocio.

## 9. Dependencias y pureza

- Única dependencia de runtime usada: builtin `node:crypto`.
- No añadir dependencias a `package.json`.
- Ningún archivo de `src/core` puede importar `node:fs`, `node:path`, código de CLI, config, source, state, destination o report.
- Ningún test usa red, filesystem, reloj real o variables de ambiente.
- No introducir mocks: el core es directamente testeable.

## 10. Orden de implementación recomendado

1. Crear `types.ts`.
2. Implementar `normalize.ts` desde la matriz de tests.
3. Implementar `fingerprint.ts` con vectores conocidos.
4. Implementar `compare.ts` y su caso mixto.
5. Añadir pruebas de errores, orden e inmutabilidad.
6. Ejecutar `npm run check`.
7. Revisar que el diff no toque CLI, README, arquitectura ni prototipo archivado salvo una corrección documental necesaria y explícita.

Antes del punto 1 debe ejecutarse `npm ci`, porque el workspace actual no tiene `node_modules` y por ello `tsc` no está disponible.

## 11. Criterio de finalización

La Etapa 2 termina solamente si:

- existen los cuatro módulos y las tres suites definidas;
- la matriz de slash de los proyectos actuales pasa;
- SHA-256 trabaja sobre bytes y produce el profile exacto;
- un segundo snapshot idéntico produce exclusivamente `unchanged`;
- el caso mixto clasifica correctamente las cuatro categorías;
- `lastmod` no provoca `updated`;
- duplicados se rechazan sin overwrite silencioso;
- resultados son deterministas e inputs no se mutan;
- no existe filesystem, red, config, CLI orchestration ni código de etapas futuras en `src/core`;
- no se añadieron dependencias npm de runtime;
- `npm run build`, `npm run lint`, `npm run test` y `npm run check` pasan;
- el CLI de Etapa 1 conserva sus pruebas y comportamiento.

## 12. Handoff a la Etapa 3

La Etapa 3 recibirá estas piezas estables:

- `normalizeUrl` para producir identidad canónica;
- `fingerprintHtml` para bytes leídos del build;
- `compareUrlRecords` para comparar el state cargado con la observación actual;
- `UrlRecord` y `ChangeSet` como modelos.

La Etapa 3 añadirá `DiscoveredResource`, `DiscoveryState`, source Astro y file state. No debe reabrir la semántica del core salvo que una fixture real de House/Cuida demuestre una contradicción; en ese caso se detiene la implementación y se registra la evidencia antes de cambiar contratos.
