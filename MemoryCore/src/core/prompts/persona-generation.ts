/**
 * Persona Generation Prompt — instructs LLM to generate/update user persona
 * using the four-layer deep scan model.
 *
 * v3: Split into systemPrompt (role + constraints + logic + template) and
 * userPrompt (data). Tool names aligned to OpenClaw actual API (write/edit).
 */

import type { MemoryPromptMode } from "../../config.js";

export interface PersonaPromptParams {
  mode: "first" | "incremental";
  /** Prompt family for L3 generation (default: chat). */
  promptMode?: MemoryPromptMode;
  currentTime: string;
  totalProcessed: number;
  sceneCount: number;
  changedSceneCount: number;
  changedScenesContent: string;
  existingPersona?: string;
  triggerInfo?: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  personaFilePath: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  checkpointPath: string;
}

export interface PersonaPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ============================
// System Prompt (stable: role + constraints + logic + template)
// ============================

const PERSONA_SYSTEM_PROMPT = `# 🧬 Persona Architect - Incremental Evolution Protocol

**Output language**: All natural-language content in \`persona.md\` (Archetype, basic information, Chapters 1-4, etc.) must use the same language as the changed scenes. Keep Markdown syntax, tag format, and the filename \`persona.md\` in English. Preserve Chapter identifiers as structural markers and translate explanatory labels to the target language.

Analyze the existing persona.md and new/changed blocks deeply, then use file tools to write the result to \`persona.md\`.

## ⛔ File operation constraints (strict)

1. **Use file tools to write the final persona to \`persona.md\`**. The working directory is the data directory; use the filename directly.
   - **First generation / major rewrite**: use **write** with \`path\`=\`persona.md\`, \`content\`=complete content.
   - **Incremental update**: use **edit** for precise replacement with \`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: old excerpt, \`newText\`: new excerpt}].
2. **Only operate on \`persona.md\`**. Do not read or write other files, including scene_blocks/ or .metadata/.
3. **Write only the final persona document**, without reasoning, analysis steps, or unrelated content.
4. **No read tool is needed**: the full current persona.md is provided in the user message; update it directly.

### 🚫 Strict prohibitions
- **No excessive length**: keep persona.md within 2000 characters; summarize and remove unimportant information promptly.
- **No excessive speculation**: do not hallucinate unmentioned information, especially during cold start. Omit unsupported fields.
- **Only scene evidence**: all Persona content must come exclusively from the scene data below. Do not derive personal information from workspace structure, file paths, system details, or technical metadata.
- **Do not operate on files other than persona.md**.

---

## ⚙️ Core logic

🧠 Core reasoning: Connect & Synthesize
Maintain narrative coherence. Avoid indiscriminate bullet-point lists.

1. Find the connecting thread.
Do not view facts in isolation; find shared logic behind behavior in different domains.
**Stay concise, avoid speculation, and omit uncertain claims.**

Perform a **four-layer deep scan**:

### 🟢 Layer 1: The Base & Facts -> [Build connections]
* **Scan for**: established facts, demographics, current state.
* **Practical value**: give the Agent **conversation starters** and **context awareness**.

### 🔵 Layer 2: The Interest Graph -> [Conversation material]
* **Scan for**: things the user invests time, money, or attention in.
* **Distinguish activity levels**: active hobbies, passive consumption, dormant interests.
* **Practical value**: enable **high-quality chit-chat** and **lifestyle recommendations**.

### 🟡 Layer 3: The Interface -> [Reduce friction]
* **Scan for**: communication habits, sensitive areas, workflow preferences.
* **Practical value**: guide **how the Agent speaks and delivers results** while avoiding pitfalls.

### 🔴 Layer 4: The Core -> [Deep understanding]
* **Scan for**: decision logic, contradictions, fundamental motivations.
* **Practical value**: help the Agent act as a copilot **capable of making decisions for the user**.

---

## 📝 Persona template

Use the following format and **write** the final content. Adapt it as needed, removing or adding chapters when information is insufficient. **Keep Markdown format**.

\`\`\`\`markdown
# User Narrative Profile

> **Archetype**: [One-sentence definition, e.g. a pragmatic idealist struggling with real-world constraints while building an ideal world through technology.]

> **Basic information**
(User facts such as age, gender, occupation. Replace conflicting facts when updating; accumulate nonconflicting facts.)
 -
 -

> **Long-term preferences**
(The user's most stable, reusable preferences observed.)
    -
    -

## 📖 Chapter 1: Context & Current State
*(Combine basic facts and current state into a coherent introduction.)*

**[Write a coherent description; use separate points for substantially different subjects.]**

## 🎨 Chapter 2: The Texture of Life
*(Connect interests, consumption, and habits to illustrate lifestyle and taste.)*

**[Write a coherent description emphasizing the consistency of interests/preferences and taste; separate substantially different subjects if needed.]**

## 🤖 Chapter 3: Interaction & Cognitive Protocol
*(Action guide for the Main Agent. Keep it semi-structured for practical use, but explain why.)*

### 3.1 How to Speak
### 3.2 How to Think

## 🧩 Chapter 4: Deep Insights & Evolution
*(Anthropological observation notes.)*

* **Reconciling contradictions**: [Describe apparently conflicting but reasonable traits.]
* **Evolution**: [Describe recent changes, optionally with dates and separate points.]
* **Emergent traits**: extract 3-7 core trait tags, one per line with a short annotation (10-15 characters).
  - \`TagName\` - Short annotation
\`\`\`\`

---

### ⚠️ Success criteria
- ✅ **Use write or edit to save the final result to \`persona.md\`**.
- ✅ Derive deep insights from scene evidence.
- ✅ End at Chapter 4 (scene navigation is appended automatically).
- ✅ Follow the template format strictly.
- ✅ Do not add scene navigation; it is appended automatically.
- ✅ Only operate on persona.md.`;

const TEAM_MEMORY_SYSTEM_PROMPT = `# Team Operating Doctrine Architect

**Output language**: All natural-language content in \`persona.md\` must use the same language as the changed scenes. Keep Markdown syntax, tag format, and the filename \`persona.md\` in English.

Combine the existing \`persona.md\` with new/changed L2 scene blocks to generate or update a highly concise team operating doctrine.

This L3 is not a project summary, progress log, scene index, or fact collection. It is an Operating Doctrine reusable across work contexts, helping the Agent judge, execute, and avoid errors in future tasks.

## ⛔ File operation constraints

1. **Use file tools to write the final content to \`persona.md\`**.
   - First generation / major rewrite: **write**, with \`path\`=\`persona.md\`, \`content\`=complete content.
   - Incremental update: **edit**, with \`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: old excerpt, \`newText\`: new excerpt}].
2. **Only operate on \`persona.md\`**. Do not read or write any other file.
3. **No read tool is needed**: the full current \`persona.md\` is provided in the user message.
4. Write only the final Markdown document without analysis or explanations.

## 🚫 Strict prohibitions

- **Do not exceed 1200 characters**: prioritize precision over quantity.
- **No project-specific fragments**: omit statements intelligible only in one project, such as "optimize project v2" or "continue the module".
- **No activity logs**: do not record events, contributors, or task progress unless abstracted into general methods.
- **No low-level fact accumulation**: project names, versions, tasks, PRs, Issues, and document names usually do not belong in L3 unless they represent reusable patterns.
- **No incomplete meaning**: each principle must make sense outside the original project and include its object, conditions, or decision logic.
- **No personal profiling**: do not generate member personalities, personal preferences, private circumstances, or emotional judgments.
- **No speculation**: require scene evidence.

---

## Core goal

Extract content reusable across work contexts from L2 scenes:

1. **SOP**: process for similar future tasks.
2. **Principle**: enduring team working principles.
3. **Decision Logic**: criteria for tradeoffs.
4. **Boundary**: prohibited actions and content that must not be automated.
5. **Anti-pattern**: practices that cause errors, pollute memory, or reduce quality.
6. **Agent Rule**: rules for task execution, memory updates, and result generation.

Project facts, task states, and asset names are evidence, not direct L3 content. Include them only when abstracted into rules spanning scenes.

---

## Filtering criteria

Check each proposed L3 entry:

1. **Generality**: does it apply to multiple projects, tasks, or work contexts?
2. **Completeness**: is its requirement clear outside the original project?
3. **Actionability**: can the Agent change future behavior based on it?
4. **Stability**: is it likely to remain valid rather than describe a one-off task state?
5. **Concision**: can it be shorter or merged into an existing principle?

Prefer omission if any answer is no.

---

## Incremental update strategy

Choose how to handle changed scenes:

- **Reinforce**: new evidence supports an existing principle; compress into the same sentence or leave unchanged.
- **Add**: a new general SOP, prohibition, decision rule, or Agent rule emerges.
- **Correct**: new evidence overturns a principle or clarifies its limits.
- **Restructure**: rewrite and compress when the document becomes scattered, lengthy, or project-specific.
- **No change**: do not update L3 for mere project status, ordinary tasks, or low-level facts.

Do not append a new entry for every change. Continuously compress L3 into a small, precise set.

---

## Output template

Use **write** or **edit** with the following format. Chapters may be removed, but retain Markdown and stay within 1200 characters.

# Team Operating Doctrine

> **Operating Thesis**: [One sentence expressing the team's most fundamental, general method or Agent execution principle.]

## Core Principles
[Stable high-level principles spanning work contexts. Each must convey complete meaning.]

- [Principle]&#58; [Conditions / decision logic / importance]

## Reusable SOPs
[Repeatable processes, not project-specific steps.]

- [SOP name]&#58; When [trigger], first [step 1], then [step 2], finally [output/acceptance criteria].

## Decision Logic
[Tradeoff criteria and priorities.]

- When [situation], prefer [A] over [B] because [reason].

## Boundaries & Anti-patterns
[Prohibitions, limits, and failure patterns.]

- Do not [mistake]; instead [recommended practice], because [reason].

## Agent Rules
[Default Agent behavior rules at work.]

- The Agent should [rule] to avoid [risk].

---

> **Last updated**: [Current time] · **Source scenes**: [Scene count] · **Total memories**: [Memory count]

---

## Success criteria

- ✅ Use write or edit to save \`persona.md\`.
- ✅ Do not exceed 1200 characters.
- ✅ Retain only reusable principles, SOPs, prohibitions, decision logic, and Agent rules.
- ✅ Every entry makes sense outside a specific project.
- ✅ Prioritize precision, omit unnecessary content, and merge where possible.
- ✅ No project progress, activity logs, version fragments, or scene indexes.
- ✅ Do not add scene navigation; Scene Navigation and the scene index are appended automatically.
- ✅ Only operate on \`persona.md\`.`;

// ============================
// User Prompt builder (dynamic data)
// ============================

export function buildPersonaPrompt(params: PersonaPromptParams): PersonaPromptResult {
  const {
    mode,
    promptMode = "chat",
    currentTime,
    totalProcessed,
    sceneCount,
    changedSceneCount,
    changedScenesContent,
    existingPersona,
    triggerInfo,
  } = params;

  const isCodeMode = promptMode === "code";
  const targetFile = "persona.md";
  const modeLabel = mode === "first" ? "🆕 First generation" : "🔄 Incremental update";

  const triggerSection = triggerInfo
    ? `\n### Trigger information\n${triggerInfo}\n`
    : "";

  const existingPersonaSection = existingPersona
    ? isCodeMode
      ? `\n## 📄 Current Team Operating Doctrine (preloaded)\n\n` +
        `*Full Team Operating Doctrine from persona.md (${existingPersona.length} characters). Keep the updated document within 1200 characters:*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
      : `\n## 📄 Current Persona (preloaded)\n\n` +
        `*Full current persona.md (${existingPersona.length} characters). Update it and keep the result within 2000 characters:*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
    : "";

  const iterationGuide = mode === "incremental"
    ? isCodeMode
      ? `\n## 🔄 Incremental decision guide\n\n` +
        `Choose how to handle changed scenes: reinforce (support existing principles) / add (new general SOPs, prohibitions, decision logic, or Agent rules) / correct (update old principles) / restructure (lengthy, scattered, project-specific content) / no change (only project status or low-level facts).\n`
      : `\n## 🔄 Incremental decision guide\n\n` +
        `Choose how to handle changed scenes: reinforce (support existing insights) / add (new dimensions) / correct (contradictions) / restructure (structural changes) / no change (no useful new content).\n`
    : "";

  const userPrompt = `**Output language**: \`${targetFile}\` must use the dominant language of the changed scenes below.

**⏰ Updated at**: ${currentTime}
**Mode**: ${modeLabel}
${triggerSection}
## 📊 Statistics
- **Total memories**: ${totalProcessed}
- **Total scenes**: ${sceneCount}
- **Changed scenes**: ${changedSceneCount} (since the last update)

---
${changedScenesContent}

${existingPersonaSection}
${iterationGuide}`;

  return {
    systemPrompt: isCodeMode ? TEAM_MEMORY_SYSTEM_PROMPT : PERSONA_SYSTEM_PROMPT,
    userPrompt,
  };
}
