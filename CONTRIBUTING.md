# Contribuir a SDI

Esta guía aplica a colaboradores humanos y agentes de IA.

## Flujo de trabajo

1. Lee [AGENTS.md](AGENTS.md) y la arquitectura antes de cambiar código.
2. Confirma que el cambio pertenece a la etapa activa del roadmap.
3. Haz un cambio pequeño y autocontenido.
4. Añade o actualiza pruebas relevantes.
5. Ejecuta `npm run check`.
6. Actualiza la documentación de uso o decisiones cuando el cambio aprobado lo requiera.

No se avanza a una etapa posterior dentro del mismo chat sin una nueva instrucción explícita.

## Estructura del proyecto

```text
src/                 Código de SDI activo.
tests/               Pruebas automatizadas.
docs/                Arquitectura y documentación de producto.
docs/ADR/            Decisiones arquitectónicas formales.
archive/sbi-prototype/  Prototipo histórico preservado; no es parte del producto activo.
```

La estructura interna del motor solo se incorporará en las etapas indicadas por el roadmap. No se reutiliza código del archivo histórico sin una decisión compatible con la arquitectura congelada.

## Definición de terminado de una etapa

Una etapa termina cuando se cumplen todos sus entregables, límites de alcance y pruebas descritos en `docs/SDI_PRODUCT_ARCHITECTURE.md`. Además, el proyecto debe compilar, pasar lint y pasar su suite de pruebas. Los elementos futuros se anotan, no se adelantan.

## Política de pruebas

- Escribe pruebas unitarias para lógica pura y pruebas de integración cuando la etapa introduzca límites de filesystem, red o procesos.
- Las pruebas deben ser deterministas y no llamar servicios externos reales en la suite normal.
- Una corrección de defecto debe incluir una prueba que reproduzca el caso cuando sea viable.
- Ejecuta `npm run test` durante el desarrollo y `npm run check` antes de entregar.

## Política de documentación

- Mantén el README orientado a usuarios y el estado real del proyecto.
- Registra decisiones cronológicas en `DECISIONS_LOG.md`.
- Crea un ADR solo para una modificación arquitectónica aprobada; sigue la guía en `docs/ADR/README.md`.
- No edites la arquitectura congelada para reflejar una implementación salvo que exista un ADR aprobado que autorice el cambio.
