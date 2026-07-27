# CoS-Agent

**Chief of Staff Agent** — una colección de automatizaciones de reportería (Daily / Weekly)
para líderes C-level, construidas sobre **Google Apps Script + Google Forms + Google Sheets**
y con generación de texto vía **Gemini**.

Cada líder opera una copia **personal** de la automatización: su propio Sheet, sus Forms y
su equipo, corriendo bajo **su propia cuenta @xertica** (los correos salen a su nombre y la
cuota es suya). La lógica común y la API key viven en una **librería compartida** (solo-lectura);
cada líder recibe una **plantilla** con un *stub* delgado que solo llama a esa librería.

> Este proyecto es el **reboot** de la v0.5 (`../Chief-of-Staff-Agent/`), rediseñada bajo
> convenciones de contratos explícitos y un modelo per-líder. Ver la relación en
> [`Docs/overview.md`](Docs/overview.md).

---

## Por dónde empezar

Toda la documentación vive en **[`Docs/`](Docs/)**. Orden de lectura sugerido:

1. [`Docs/overview.md`](Docs/overview.md) — qué es, por qué Apps Script + librería, qué hay hoy.
2. [`Docs/architecture-and-contracts.md`](Docs/architecture-and-contracts.md) — capas y contratos.
3. [`Docs/conventions.md`](Docs/conventions.md) — patrón librería + stub y estructura de archivos.
4. [`Docs/engineering-playbook.md`](Docs/engineering-playbook.md) — reglas prácticas para escribir el código.
5. [`Docs/workflows/CLEVEL-REPORTS/CLEVEL-REPORTS.md`](Docs/workflows/CLEVEL-REPORTS/CLEVEL-REPORTS.md) — el workflow.
6. [`Docs/workflows/CLEVEL-REPORTS/sidebar-and-prompts.md`](Docs/workflows/CLEVEL-REPORTS/sidebar-and-prompts.md) — el sidebar y los prompts editables.

## Estructura del repo

```
CoS-Agent/
├── README.md                     ← este archivo
├── cos.config.example.json       ← plantilla de config (IDs específicos del entorno)
├── package.json                  ← tooling local (clasp, tests)
├── .gitignore
├── Images/                       ← capturas de referencia (estructura AOS)
├── Docs/                         ← toda la documentación
│   ├── README.md
│   ├── overview.md
│   ├── architecture-and-contracts.md
│   ├── conventions.md
│   ├── engineering-playbook.md
│   └── workflows/CLEVEL-REPORTS/
│       ├── CLEVEL-REPORTS.md
│       └── sidebar-and-prompts.md
├── shared/                       ← (futuro) helpers runtime compartidos de la librería
├── workflows/                    ← (futuro) código container-bound por workflow
├── tests/                        ← (futuro) tests de contrato con mocks de GAS
└── scripts/                      ← (futuro) tooling local (sync, deploy)
```

> **Estado:** este commit contiene **solo documentación + scaffolding**. Aún no hay código
> `.gs`. Las carpetas `shared/`, `workflows/`, `tests/` y `scripts/` están vacías a propósito.

## Convención de nombres

- **`cos.config.json`** (real, *gitignored*) guarda los IDs específicos de tu entorno.
  Copia [`cos.config.example.json`](cos.config.example.json) y complétalo.
- La **API key de Gemini nunca** va en el repo ni en `cos.config.json`: vive en las
  **Script Properties** de la librería. Ver [`Docs/conventions.md`](Docs/conventions.md).
