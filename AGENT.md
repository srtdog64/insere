# AGENT.md (AI Development Rules)

이 문서는 프로젝트의 **"추론 불확실성(Reasoning Uncertainty)"**을 제거하고, 복잡성이 증가하더라도 시스템의 예측 가능성을 유지하기 위한 핵심 원칙을 정의합니다. 모든 개발 및 AI 에이전트 활동은 이 정책을 엄격히 준수해야 합니다.

This document defines the core principles to eliminate **"Reasoning Uncertainty"** and maintain system predictability as complexity increases. All development and AI agent activities must strictly adhere to these policies.

---

## 1. 핵심 원칙 (Hard Constraints)

### 1.1 결과 우선 경계 (Result-First Error Handling)
- **[KR]** 모든 실패 가능한 작업은 `Result<T>`를 반환해야 합니다. 제어 흐름을 위한 `throw` 사용은 금지됩니다.
- **[EN]** All failable operations must return `Result<T>`. Using `throw` for control flow is prohibited.
- **[KR]** 예외는 오직 프로세스 경계(초기화 실패 등) 또는 I/O 경계(외부 라이브러리 래핑)에서만 허용됩니다.
- **[EN]** Exceptions are only allowed at process boundaries (initialization failure, etc.) or I/O boundaries (wrapping external libraries).

### 1.2 명시적인 안전하지 않은 래퍼 (Explicit Unsafe Wrappers)
- **[KR]** `throw`를 발생시키거나 `Result`를 반환하지 않는 메서드는 `unsafe` 접두사 등을 통해 명확히 구분되어야 합니다.
- **[EN]** Methods that throw or do not return `Result` must be clearly distinguished using prefixes like `unsafe`.

---

## 2. 로깅 및 디버깅 (Zero Ambiguity)

### 2.1 구조화된 버그 로깅 (Structured Machine-Parseable Logs)
- **[KR]** 로그는 반드시 JSON 객체 형태여야 하며, `stage`, `event`, `errorCode` 필드를 포함해야 합니다.
- **[EN]** Logs must be JSON objects containing `stage`, `event`, and `errorCode` fields.
- **[KR]** 이벤트 이름 규칙: `[Stage]_[Operation]_[Status]` (예: `Authorize_TokenValidation_Failed`)
- **[EN]** Event naming rule: `[Stage]_[Operation]_[Status]` (e.g., `Authorize_TokenValidation_Failed`)

### 2.2 호스트 클록 타이밍 (Host Clock Timing)
- **[KR]** 시스템의 모든 시간 측정은 호스트 클록(Host Clock) 인터페이스에 의존해야 합니다.
- **[EN]** All time measurements in the system must depend on a Host Clock interface.

---

## 3. 아키텍처 및 통신 (Architecture & Communication)

### 3.1 이벤트 버스 의미론적 분할 (Event Bus Semantic Partitioning)
- **[KR]** 이벤트 버스는 도메인 경계에 따라 의미론적으로 분할되어야 합니다.
- **[EN]** The event bus must be semantically partitioned according to domain boundaries.

### 3.2 정책 중심 설계 (Policy-Centered Architecture)
- **[KR]** 결정 로직(Validation, Retry 등)은 전용 **Policy** 객체에 모으고 주입 가능해야 합니다.
- **[EN]** Decision logic (Validation, Retry, etc.) must be collected in dedicated **Policy** objects and be injectable.

---

## 4. 재시도 정책 (Retry Policy)

- **[KR]** 재시도는 오직 `maxAttempts`, `retryOn`, `backoffMs`가 명시된 `RetryPolicy`를 통해서만 수행됩니다.
- **[EN]** Retries are only performed through a `RetryPolicy` specifying `maxAttempts`, `retryOn`, and `backoffMs`.
- **[KR]** 모든 재시도 작업은 멱등성(Idempotency)이 보장되어야 합니다.
- **[EN]** All retry operations must guarantee idempotency.

---

## 5. 완료 정의 (Definition of Done)

- [ ] **[KR]** 실패 경로가 테스트로 검증되었는가? / **[EN]** Failure paths verified by tests?
- [ ] **[KR]** 에러가 `Result`로 명시되었는가? / **[EN]** Errors explicit via `Result`?
- [ ] **[KR]** 구조화된 로그가 기록되는가? / **[EN]** Structured logs recorded?
- [ ] **[KR]** 정책 결정이 코드에서 분리되었는가? / **[EN]** Policy decisions decoupled from code?
