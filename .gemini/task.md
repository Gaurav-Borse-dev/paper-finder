# Tasks: Fix Heuristic Extraction & Import Validation

- `[x]` **Component 1: Fix Heuristic Extraction in extract.ts**
  - `[x]` A. Fix `matchSemester` — add year prefixes (FY/SY/TY/BE), ordinal patterns, SEM-III
  - `[x]` B. Fix `matchDepartment` DEPT_ABBRS — add missing abbreviations
  - `[x]` C. Fix exam type `comp` conflict with Complementary
  - `[x]` D. Fix `matchMarks` — remove dangerous generic fallback
  - `[x]` E. Improve text confidence levels (0.70 → 0.90/0.95 for exact matches)
  - `[x]` F. Extract 2 pages instead of 1
  - `[x]` G. Fix `parseFromFilename` — process dept before stripping
- `[x]` **Component 2: Cross-Validate QP/AK and Verify Existing Records in import.ts**
  - `[x]` A. Cross-validate QP/AK metadata during matching
  - `[x]` B. Verify/fix existing papers during re-import
  - `[x]` C. Improve matchRecord construction — pick highest confidence
- `[x]` **Verification**
  - `[x]` Compile check (`npx tsc --noEmit`)
