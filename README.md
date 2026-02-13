# ClassIn Live - 라이브 클래스 플랫폼

## 프로젝트 개요
- **Name**: ClassIn Live
- **Goal**: Class101과 유사한 온라인 라이브 강의 판매 플랫폼
- **Tech Stack**: Hono + TypeScript + Cloudflare Pages + D1 Database + TailwindCSS

## 현재 완료된 기능

### 메인 페이지
- 히어로 배너 (라이브 강의 소개)
- 카테고리 10개 (드로잉, 프로그래밍, 요리, 음악, 운동, 사진, 비즈니스, 외국어, 라이프스타일, 디자인)
- 베스트 클래스 섹션
- 예정된 라이브 클래스 섹션
- 신규 클래스 섹션
- 구독 플랜 섹션 (월간/연간)

### 카테고리 브라우징
- 카테고리별 필터링
- 정렬 (인기순, 평점순, 최신순, 가격순)
- 난이도 필터 (입문/중급/고급)
- 검색 기능
- 더보기 (페이지네이션)

### 클래스 상세 페이지
- 클래스 정보 (제목, 설명, 가격, 할인율)
- 커리큘럼 (챕터별 정리, 접기/펼치기)
- 강사 소개 (프로필, 경력, 통계)
- 수강생 후기 (별점 통계, 개별 리뷰)
- 준비물 & 사전 지식
- 수강 인원 프로그레스 바
- 라이브 일정 표시

### 결제 시스템
- 개별 클래스 구매
- 구독 결제 (월간 19,900원 / 연간 159,000원)
- 카드 결제 (번호, 유효기간, CVC 입력)
- 카카오페이, 네이버페이 선택
- 쿠폰 코드 입력
- 결제 동의 체크
- 결제 완료 확인 모달

### 회원 시스템
- 회원가입 (이름, 이메일, 비밀번호)
- 로그인 (이메일, 비밀번호)
- 소셜 로그인 UI (구글, 카카오, 네이버)
- 로그아웃

### 마이페이지
- 수강 중인 클래스 (진행률 바)
- 찜 목록
- 결제 내역 (거래번호, 결제상태)

### 장바구니
- 클래스 담기/제거
- 전체 결제
- 장바구니 뱃지

### 기타
- 반응형 디자인 (모바일/태블릿/데스크탑)
- 검색 기능 (제목, 설명, 태그 검색)
- LIVE 뱃지 애니메이션
- 카드 호버 효과

## API 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/categories` | 전체 카테고리 |
| GET | `/api/classes` | 클래스 목록 (필터, 정렬, 검색) |
| GET | `/api/classes/featured` | 베스트 클래스 |
| GET | `/api/classes/new` | 신규 클래스 |
| GET | `/api/classes/:slug` | 클래스 상세 (커리큘럼, 리뷰 포함) |
| POST | `/api/auth/login` | 로그인 |
| POST | `/api/auth/register` | 회원가입 |
| GET | `/api/user/:id/enrollments` | 수강 목록 |
| GET | `/api/user/:id/wishlist` | 찜 목록 |
| POST | `/api/wishlist` | 찜 추가 |
| DELETE | `/api/wishlist` | 찜 제거 |
| GET | `/api/user/:id/cart` | 장바구니 |
| POST | `/api/cart` | 장바구니 추가 |
| DELETE | `/api/cart` | 장바구니 제거 |
| POST | `/api/payment/process` | 결제 처리 |
| GET | `/api/user/:id/orders` | 결제 내역 |
| POST | `/api/reviews` | 리뷰 작성 |

## 데이터 아키텍처
- **Database**: Cloudflare D1 (SQLite)
- **Tables**: users, instructors, categories, classes, lessons, reviews, orders, enrollments, wishlist, cart
- **샘플 데이터**: 강사 8명, 카테고리 10개, 클래스 12개, 리뷰 8개

## 테스트 계정
- 학생: `student1@test.com` / (아무 비밀번호)
- 관리자: `admin@classin.kr` / (아무 비밀번호)

## 배포
- **Platform**: Cloudflare Pages
- **Status**: 개발 중
- **Last Updated**: 2026-02-13
