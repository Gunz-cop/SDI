# Architectural Decision Records (ADR)

Un ADR registra una decisión arquitectónica relevante, su contexto y sus consecuencias. Complementa el registro cronológico de decisiones; no lo sustituye.

## Cuándo crear un ADR

Crear un ADR únicamente cuando se apruebe una modificación de la arquitectura congelada, un cambio de alcance o una decisión estructural que afecte el producto. No se usa para tareas rutinarias de implementación ni para ideas futuras aún no aprobadas.

## Formato recomendado

Cada ADR debe incluir:

1. Título y estado (`propuesto`, `aceptado`, `rechazado` o `reemplazado`).
2. Contexto y problema que motivan la decisión.
3. Decisión tomada.
4. Consecuencias, compromisos y migración si aplica.
5. Referencias al documento de arquitectura, issues o decisiones relacionadas.

## Numeración

Usa nombres consecutivos con cuatro dígitos y un título breve en kebab case:

```text
0001-titulo-breve.md
```

La numeración no se reutiliza. Un ADR que reemplace otro debe enlazarlo explícitamente y conservar el registro anterior.
