# 광고 시안(배너) 제작 에이전트

배경과 결정은 [CLAUDE.md](CLAUDE.md), [docs/architecture.md](docs/architecture.md), [docs/decisions.md](docs/decisions.md) 참고.

## 현재 범위: MVP 1단계
질문지(광고주, 모바일) → 브리프 2부(AI 초안, 출처 태그) → 아이디어 3안 → 게이트 1(사람이 확정·선택·승인)

## 실행
```bash
npm install
npm run dev                  # http://localhost:3000
```
LLM 호출 방식은 `config/settings.json` 의 `llm.backend` 로 고른다 (환경 변수 `AD_AGENT_LLM_BACKEND` 가 우선).
- `"claude-cli"` (현재 기본): 로그인된 Claude Code CLI(`claude -p --json-schema`)를 쓴다. API 키가 필요 없다. 개발·시험용.
- `"api"`: Anthropic API 키를 쓴다. `cp .env.example .env.local` 후 `ANTHROPIC_API_KEY` 입력 (저장소에 올리지 않음). 웹 배포(BYOK)는 이 경로를 쓴다.
- 광고주 질문지: `/intake`
- 내부 콘솔: `/console`
- API 키 없이 화면만 시험: `npm run dev:fake` (포트 3001, 가짜 모델 응답, 케이스는 `cases-fake/`)
- 실제 모델로 가상 광고주(쿠키 가게) 1회 실행: `npm run demo:cookie` (CLI 백엔드 기준 약 3~4분, 약 $0.4)
- 테스트(API 호출 없음): `npm test`

## 구조
| 경로 | 내용 |
|---|---|
| `.claude/skills/` | 스킬 = 프롬프트의 단일 원본. 서버가 SKILL.md를 읽어 시스템 프롬프트로 쓴다 |
| `src/core/intake.ts` | 1부 질문 0~11번 스키마, 모델에 보내는 형태(담당자·연락처 제외) |
| `src/core/brief.ts` | 브리프 항목 정의, 태그·"추정" 표시를 코드로 붙임, 체크리스트, 02_brief.md 렌더 |
| `src/core/ideas.ts` | 방향표, 아이디어 검증, 03_ideas.md 렌더 |
| `src/core/validate.ts` | 지어낸 숫자·근거, 금지어, 심의 키워드, 이미지 속 글자·로고 묘사 검사 |
| `src/core/case.ts` | 케이스 폴더, 상태 전이, 게이트 1 승인과 잠금, approvals.md |
| `src/llm/` | Claude 호출(CLI 또는 API, 구조화된 출력), 검증 실패 시 1회 재생성, llm_log.jsonl(시도별 검증 결과·비용) |
| `config/settings.json` | 모델, 미정 항목(수정 횟수·가격·보관 기간·이미지 모델) |

## 규칙을 지키는 방법
- 모델은 JSON 스키마로만 답하고, 출처 태그와 `[추정]`은 코드가 붙인다. "모르겠음" 질문에서 나온 항목은 모델이 빠뜨려도 `[추정]`이 붙는다.
- 1부 3번 답이 있으면 목적은 그 값으로 고정한다. 근거는 1부 6번에 글자 그대로 있는 문구만 남긴다.
- 검증 오류(지어낸 숫자, 금지어, "모두" 타깃, 이미지 속 글자·로고 등)가 있으면 1회 다시 생성하고, 그래도 남으면 "사람이 확정할 항목"에 올린다.
- 게이트 1은 확정 항목이 모두 처리되고 아이디어 1안이 선택되어야 통과한다. 승인 후에는 브리프·아이디어를 바꿀 수 없다.
