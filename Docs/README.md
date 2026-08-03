# Docs — CoS-Agent

Documentación del proyecto. Escrita para lectores **técnicos y no-técnicos**: la prosa está en
español; el código, identificadores y claves de config quedan en inglés.

## Orden de lectura

| # | Documento | Para qué |
|---|---|---|
| 1 | [overview.md](overview.md) | Qué es CoS-Agent, por qué Apps Script + librería, qué hay en scope hoy y la migración futura. |
| 2 | [architecture-and-contracts.md](architecture-and-contracts.md) | Mapa de capas, quién posee qué, y los contratos explícitos que no se deben romper. |
| 3 | [conventions.md](conventions.md) | El patrón **librería + stub**, un script container-bound por líder, estructura de archivos y manifiesto. |
| 4 | [engineering-playbook.md](engineering-playbook.md) | Reglas prácticas para escribir el código: modularización, runtime, capas de prompts y el bridge de Gemini. |
| 5 | [workflows/CLEVEL-REPORTS/CLEVEL-REPORTS.md](workflows/CLEVEL-REPORTS/CLEVEL-REPORTS.md) | El workflow integrado Daily + Weekly: intent, supuestos, mapa, config y flujos. |
| 6 | [workflows/CLEVEL-REPORTS/sidebar-and-prompts.md](workflows/CLEVEL-REPORTS/sidebar-and-prompts.md) | El sidebar de 3 paneles, el modal de formularios (preguntas + IA) y el contrato de prompts editables. |
| 7 | [testing-and-deploy.md](testing-and-deploy.md) | Estrategia de tests (Node + mocks GAS, smoke manual) y flujo clasp: push, versionamiento y promoción a los líderes. |
| 8 | [installation.md](installation.md) | Paso a paso de despliegue: crear librería + plantilla con clasp, cablear scriptId, key, versión, configurar el sidebar y checklist de smoke. |
| 9 | [deploy-terminal.md](deploy-terminal.md) | Runbook de terminal: cada comando `clasp` en orden con **para qué sirve**; marca los pasos de navegador. Copiar/pegar. |
| 10 | [onboarding-lider.md](onboarding-lider.md) | Habilitar la automatización a **otro líder** (otro correo): preparación del admin (versión fija, compartir librería, plantilla limpia) + pasos del nuevo líder. |

## Convenciones de esta documentación

- **Status legend.** Cada comportamiento se marca como:
  - `Implemented` — el código existe hoy y su comportamiento es parte del contrato de runtime.
  - `High-level` — solo está definido el *intent* de negocio; el spec detallado es TBD.

  > El runtime ya está **implementado** en la librería `CoSLib`; lo que queda `High-level` son
  > extensiones futuras (p. ej. la migración a Add-on).

- **Contratos sobre abstracción.** Si un comportamiento debe reusarse, se define un contrato en
  `shared/`, se documenta aquí y se cubre con un test. Si es específico de un workflow, se queda
  en ese workflow. Ver [architecture-and-contracts.md](architecture-and-contracts.md).

- **Enlaces canónicos.** Los mapas de archivo/test viven en
  [architecture-and-contracts.md#anclas-de-implementación](architecture-and-contracts.md#anclas-de-implementación).
  Otros docs enlazan ahí en vez de repetir listas de archivos.

## Material de referencia

Las capturas en [`../Images/`](../Images/) muestran la estructura del proyecto **AOS (Agentic OS)**
que sirvió de molde para esta documentación (mismos archivos `docs/`, misma filosofía de contratos).
