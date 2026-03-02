# LLM as Judge Step

## Purpose
Use an LLM-based evaluator to score model outputs for contract tasks.

## Inputs
- Source contract text/chunks
- User question or task prompt
- System output (summary / answer / risk flags)
- Expected rubric

## Core Checks
1. Groundedness: Are claims supported by cited contract evidence?
2. Completeness: Are required fields/clauses covered?
3. Accuracy: Any contradictions with source text?
4. Citation quality: Are references specific and relevant?
5. Risk labeling quality: Correct type/severity rationale?

## Output Schema (draft)
```json
{
  "score": 0,
  "verdict": "pass|fail|needs_review",
  "groundedness": 0,
  "completeness": 0,
  "accuracy": 0,
  "citation_quality": 0,
  "risk_label_quality": 0,
  "notes": [],
  "failure_reasons": []
}
```

## TODO
- Finalize rubric weights.
- Define threshold for pass/fail.
- Add prompt template and few-shot examples.
- Wire this step into evaluation pipeline.
