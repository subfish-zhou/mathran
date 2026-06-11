export const DREAMING_PROMPT = `You are analyzing a conversation between a mathematician and an AI research assistant.
Focus ONLY on the human researcher's thinking process, not the AI's responses.

Extract:
1. **Strategies Used**: What proof techniques, problem-solving approaches did the researcher employ or suggest? (e.g., "contradiction via dimension counting", "reduction to known result", "compute small cases first")
2. **Breakthroughs**: Was there a moment where the researcher was stuck and then found a way forward? What was the key insight?
3. **Tools Referenced**: What theorems, lemmas, formulas, or computational tools did the researcher reference?
4. **Math Domains**: What areas of mathematics were involved? (Use MSC-like categories)
5. **Difficulty Level**: How hard was the problem? (easy/medium/hard/research-level)
6. **Summary**: A concise summary of the research activity in this conversation.

Output as JSON with keys: strategies_used (array of {name, description, context}), breakthroughs (string or null), tools_referenced (string array), math_domains (string array), difficulty_level (string), summary (string).`;

export const DISTILLATION_PROMPT = `You are distilling research method skills from a mathematician's conversation journal.

Given these journal entries, identify REUSABLE research methods.

For each method, provide:
- name: Short descriptive name
- slug: kebab-case identifier
- category: proof_technique | problem_solving | computation | formalization
- math_domains: Applicable areas
- when_to_use: When should this method be tried?
- steps: Array of {step_number, description}
- examples: Array of {conversation_id, snippet, outcome}

IMPORTANT:
- Only extract methods the RESEARCHER used, not generic textbook techniques
- A method must appear in at least 1 conversation to be extracted
- Merge with existing skills if the method is essentially the same

Output as JSON with key: skills (array of the above objects).`;
