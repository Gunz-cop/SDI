# SDI — Search Discovery Infrastructure

SDI es una herramienta npm para detectar cambios relevantes en URLs publicadas y comunicar esos cambios a destinos de descubrimiento. SDI 0.1 se orienta a sitios Astro estáticos.

Repositorio oficial del proyecto: [github.com/Gunz-cop/SDI](https://github.com/Gunz-cop/SDI)

El producto elimina la lógica copiada y divergente de varios proyectos: en lugar de reanunciar un sitemap completo o avanzar estado tras un fallo, SDI centralizará el descubrimiento, la comparación y la notificación de cambios. No promete indexación ni ranking; la aceptación de una notificación solo confirma que el destino la recibió.

## Estado del proyecto

Las Etapas 1–4 y las subetapas 5.0–5.4 están implementadas: SDI incluye configuración, runner, reportes y CLI para dry-run, baseline y live. La implementación de SDI 0.1 está feature-complete y su arquitectura permanece congelada, pero el cierre formal sigue pendiente. Vet24 está suspendido como candidato de migración mientras se evalúa su arquitectura SSR/híbrida; no existe un ADR abierto para ampliar o corregir ese alcance. La planificación posterior no debe interpretarse como cierre ni publicación de 0.1.

## Instalación

SDI requiere Node.js 22.12 o posterior (Node 24 LTS recomendado).

```bash
npm install
```

Para usar el paquete desde un proyecto consumidor cuando se publique o se instale localmente:

```bash
npm install --save-dev @sdi/cli
```

### Validación local desde un tarball

La preparación del piloto se puede repetir sin publicar el paquete ni instalarlo desde el workspace. Desde la raíz de SDI, genera un tarball real, instala ese archivo en un consumidor Astro temporal limpio y ejecuta `sdi` desde `node_modules/.bin`:

```bash
npm run build
node examples/astro/verify-tarball.mjs
```

El validador inspecciona el contenido de `npm pack`, copia `examples/astro/consumer` a un directorio temporal, instala el `.tgz` y ejecuta `npx sdi --help`, `npx sdi --version`, `npx sdi baseline --confirm` y dos `npx sdi run --dry-run`. Después de instalar, fuerza modo offline y bloquea `fetch`; por tanto baseline y los dry-runs fallarían si intentaran usar la red. El directorio temporal se elimina al terminar.

## Ejecución

Construye el binario y consulta su ayuda:

```bash
npm run build
node dist/cli.js --help
```

Tras instalar el paquete, la misma ayuda estará disponible mediante:

```bash
npx sdi --help
```

Ejecuta un dry-run, un baseline inicial confirmado o un run live después del deploy:

```bash
npx sdi run --dry-run
npx sdi baseline --confirm
npx sdi run
```

## Roadmap resumido

1. Fundación del repositorio, tooling y binario.
2. Core puro: tipos, normalización, fingerprints y comparación.
3. Source Astro y estado seguro.
4. IndexNow, reintentos y reportes.
5. CLI y flujo end-to-end.
6. Piloto HouseGatitos y migraciones graduales.

La referencia completa y vinculante es [docs/SDI_PRODUCT_ARCHITECTURE.md](docs/SDI_PRODUCT_ARCHITECTURE.md).
