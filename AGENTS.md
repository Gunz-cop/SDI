# Contrato de trabajo para agentes de SDI

## Filosofía

- SDI es un producto, no una colección de scripts copiados.
- La arquitectura tiene prioridad sobre la velocidad de implementación.
- El alcance de SDI 0.1 está congelado.

## Fuente de verdad

La referencia principal es [docs/SDI_PRODUCT_ARCHITECTURE.md](docs/SDI_PRODUCT_ARCHITECTURE.md). Sus decisiones de alcance, contratos y roadmap prevalecen sobre inferencias o preferencias de implementación.

## Forma de trabajo

Los agentes deben implementar únicamente una etapa por chat, mantener los cambios pequeños y revisar el criterio de finalización de la etapa antes de avanzar. Todo cambio de comportamiento debe incluir pruebas proporcionales; se debe evitar la duplicación y respetar el roadmap aprobado.

## Restricciones

No se permite:

- rediseñar la arquitectura;
- ampliar el alcance de SDI 0.1;
- introducir funcionalidades futuras por anticipación;
- eliminar compatibilidad legacy antes de completar su migración.

## Gestión de deuda técnica

Si durante una etapa aparece una mejora fuera de alcance, no se implementa. Se registra como propuesta futura o ADR, según corresponda, y se continúa únicamente con la etapa actual.

## Calidad

Todo código nuevo debe ser modular, tipado, probado y fácil de mantener. Los agentes deben mantener la documentación coherente con los cambios aprobados, actualizar `CHANGELOG.md` en `Unreleased` cuando el cambio modifique el estado real del producto y no modificar silenciosamente la arquitectura congelada.

## Identidad Git de Terra

Para los commits y pushes de Terra en este repositorio se usa la identidad Git local `Terra (Codex) <terra@users.noreply.github.com>`. Los chats posteriores deben conservarla salvo instrucción explícita del usuario.
