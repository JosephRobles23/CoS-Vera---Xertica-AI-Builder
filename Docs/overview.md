# Overview

**CoS-Agent** (*Chief of Staff Agent*) es una colección de automatizaciones pequeñas que
capturan reportes **Daily** y **Weekly** de un equipo y devuelven a su líder C-level un
**resumen ejecutivo** — sin trabajo manual de seguimiento ni consolidación.

Cada automatización es una unidad autocontenida que vive en Google Drive y es operada por
un humano (el líder) a través de un **Google Sheet de settings** con un **sidebar** de
configuración. La generación de texto (resúmenes y consolidados) la hace **Gemini**.

---

## Qué resuelve

Un líder C-level en Xertica necesita saber, cada día y cada semana: qué logró su equipo, qué
lo bloquea, qué cambió y qué amerita su atención — sin perseguir a nadie ni leer 8 formularios.
CoS-Agent:

1. **Invita** a cada persona del equipo a llenar su Daily/Weekly a una hora configurable.
2. **Resume** automáticamente cada respuesta en una columna `Summary` de la fila (vía Gemini).
3. **Consolida** al cierre del día/semana todos los `Summary` en un correo ejecutivo al líder.
4. Permite al líder **personalizar** preguntas, prompts, horarios y equipo desde un sidebar,
   sin tocar código.

---

## Modelo: personal por líder

A diferencia de la v0.5 (un Sheet central multi-líder operado por un admin), en CoS-Agent
**cada líder posee su propia copia**:

- Su propio **Sheet** (settings + datos), sus **Forms** Daily/Weekly y su **equipo**.
- Todo corre **como el líder**: los correos salen de su cuenta @xertica y la cuota es suya.
- No hay un admin central ejecutando nada; el líder autoriza una vez y la automatización es suya.

Esto es lo que hace la automatización **personal y ligada al correo de cada líder**.

---

## Por qué Apps Script + una librería (por ahora)

El MVP corre en **Google Apps Script + Google Drive** porque:

- **Cero infraestructura.** Un workflow se distribuye como un Sheet + un script + Forms. No hay
  servidores que aprovisionar.
- **Participación no-técnica.** El líder configura todo (preguntas, prompts, horarios, equipo)
  desde un sidebar dentro de su Sheet — nunca ve código.
- **El modelo de distribución ES el artefacto.** Repartir la automatización = compartir una
  **plantilla** que el líder copia. Copiar el Sheet copia el stub y su enganche a la librería.

La lógica común no se copia en cada Sheet: vive en una **librería compartida** (solo-lectura).
Cada Sheet de líder trae un **stub** delgado que llama a la librería. Así:

- El **código y la API key quedan ocultos** (el key vive en las Script Properties de la librería
  y no se copia aunque alguien copie la librería).
- Un cambio en la librería se propaga a **todos** los líderes sin recopiar código.

> **Nota de honestidad de seguridad.** La librería solo-lectura **ofusca**, no cifra: quien
> tenga acceso de lectura puede ver el código (no el key). Para ocultar también el código, la
> vía real es un **Add-on** (ver *Migración futura*). Detalle del patrón y sus límites en
> [architecture-and-contracts.md](architecture-and-contracts.md) y [conventions.md](conventions.md).

---

## Qué hay en scope hoy

- Un workflow activo: **[CLEVEL-REPORTS](workflows/CLEVEL-REPORTS/CLEVEL-REPORTS.md)** —
  captura Daily (L–V) y Weekly (viernes), resumen por fila y consolidados al líder.
- Un **sidebar de 4 paneles** (Preguntas, Prompts, Horarios, Equipo) para que el líder
  configure todo — ver [sidebar-and-prompts.md](workflows/CLEVEL-REPORTS/sidebar-and-prompts.md).
- **Prompts editables por líder** en capas (`soul.md` = voz, `user.md` = contexto,
  system-prompts por tarea), con defaults baked-in en la librería.
- Motor de texto en **Gemini** vía API key de Google AI Studio (Flash por fila, Pro para
  consolidados).
- Triggers: `onFormSubmit` (resumen por fila) + `dispatcher` cada 5 min (invitaciones y
  consolidados por hora).

> **Estado global:** todo lo anterior está hoy como **spec** (`High-level`). El código `.gs`
> se implementará en una fase posterior; este repo entrega la documentación y el scaffolding.

---

## Migración futura

Cuando el workflow madure y la escala lo pida:

- **Add-on de Workspace** — para ocultar el código por completo y evitar la advertencia de
  "app no verificada"; reusa casi toda la base de la librería.
- **Centralización opcional (GCP)** — un orquestador compartido, dashboards y observabilidad,
  reconectando la capa de agentes (Vera) descrita en la arquitectura de la v0.5.

La centralización se **difiere a propósito**: cada workflow puede desprenderse y reconstruirse
de forma independiente cuando llegue su turno. No es un objetivo del MVP.
