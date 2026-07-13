# SDI — Search Discovery Infrastructure

SDI es una herramienta npm para detectar cambios relevantes en URLs publicadas y comunicar esos cambios a destinos de descubrimiento. SDI 0.1 se orienta a sitios Astro estáticos.

Repositorio oficial del proyecto: [github.com/Gunz-cop/SDI](https://github.com/Gunz-cop/SDI)

El producto elimina la lógica copiada y divergente de varios proyectos: en lugar de reanunciar un sitemap completo o avanzar estado tras un fallo, SDI centralizará el descubrimiento, la comparación y la notificación de cambios. No promete indexación ni ranking; la aceptación de una notificación solo confirma que el destino la recibió.

## Estado del proyecto

Las Etapas 1–4 están completadas. Las subetapas 5.0–5.2 entregan la configuración interna, dry-run y baseline del runner. La arquitectura de SDI 0.1 está congelada. El CLI todavía solo ofrece ayuda y enumera los comandos previstos; live y los comandos funcionales pertenecen a las subetapas restantes de la Etapa 5.

## Instalación

SDI requiere Node.js 22.12 o posterior (Node 24 LTS recomendado).

```bash
npm install
```

Para usar el paquete desde un proyecto consumidor cuando se publique o se instale localmente:

```bash
npm install --save-dev @sdi/cli
```

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

Los comandos `sdi run` y `sdi baseline` aparecen únicamente como comandos previstos; no están implementados en esta etapa.

## Roadmap resumido

1. Fundación del repositorio, tooling y binario.
2. Core puro: tipos, normalización, fingerprints y comparación.
3. Source Astro y estado seguro.
4. IndexNow, reintentos y reportes.
5. CLI y flujo end-to-end.
6. Piloto HouseGatitos y migraciones graduales.

La referencia completa y vinculante es [docs/SDI_PRODUCT_ARCHITECTURE.md](docs/SDI_PRODUCT_ARCHITECTURE.md).
