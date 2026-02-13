-- Seed data for ClassIn Live platform

-- Users (password is 'test1234' hashed)
INSERT OR IGNORE INTO users (id, email, password_hash, name, avatar, role) VALUES
(1, 'admin@classin.kr', 'pbkdf2_test1234', '관리자', '', 'admin'),
(2, 'kim.art@classin.kr', 'pbkdf2_test1234', '김예진', 'https://api.dicebear.com/7.x/avataaars/svg?seed=kimyejin', 'instructor'),
(3, 'lee.dev@classin.kr', 'pbkdf2_test1234', '이준호', 'https://api.dicebear.com/7.x/avataaars/svg?seed=leejunho', 'instructor'),
(4, 'park.cook@classin.kr', 'pbkdf2_test1234', '박서연', 'https://api.dicebear.com/7.x/avataaars/svg?seed=parkseoyeon', 'instructor'),
(5, 'choi.music@classin.kr', 'pbkdf2_test1234', '최민수', 'https://api.dicebear.com/7.x/avataaars/svg?seed=choiminsu', 'instructor'),
(6, 'jung.fitness@classin.kr', 'pbkdf2_test1234', '정하늘', 'https://api.dicebear.com/7.x/avataaars/svg?seed=junghaneul', 'instructor'),
(7, 'hong.photo@classin.kr', 'pbkdf2_test1234', '홍지우', 'https://api.dicebear.com/7.x/avataaars/svg?seed=hongjiwoo', 'instructor'),
(8, 'student1@test.com', 'pbkdf2_test1234', '테스트학생', '', 'student'),
(9, 'yang.biz@classin.kr', 'pbkdf2_test1234', '양승현', 'https://api.dicebear.com/7.x/avataaars/svg?seed=yangsh', 'instructor'),
(10, 'shin.lang@classin.kr', 'pbkdf2_test1234', '신유리', 'https://api.dicebear.com/7.x/avataaars/svg?seed=shinyuri', 'instructor');

-- Instructors
INSERT OR IGNORE INTO instructors (id, user_id, display_name, bio, profile_image, specialty, total_students, total_classes, rating, verified) VALUES
(1, 2, '김예진', '10년차 일러스트레이터. 카카오, 라인프렌즈 캐릭터 디자인 참여. 감성적인 드로잉으로 많은 수강생에게 사랑받고 있습니다.', 'https://api.dicebear.com/7.x/avataaars/svg?seed=kimyejin', '일러스트·드로잉', 12500, 8, 4.9, 1),
(2, 3, '이준호', 'Google, 네이버 출신 시니어 개발자. 15년 실무 경험을 바탕으로 실전 코딩을 가르칩니다. 알기 쉬운 설명이 강점!', 'https://api.dicebear.com/7.x/avataaars/svg?seed=leejunho', '프로그래밍·개발', 18200, 12, 4.8, 1),
(3, 4, '박서연', '르 코르동 블루 출신 셰프. 한식, 양식, 디저트까지 폭넓은 레시피를 쉽고 재미있게 알려드립니다.', 'https://api.dicebear.com/7.x/avataaars/svg?seed=parkseoyeon', '요리·베이킹', 8900, 6, 4.7, 1),
(4, 5, '최민수', '버클리 음대 졸업. 기타리스트이자 프로듀서. 초보자도 쉽게 따라할 수 있는 음악 강의를 만듭니다.', 'https://api.dicebear.com/7.x/avataaars/svg?seed=choiminsu', '음악·악기', 6700, 5, 4.8, 1),
(5, 6, '정하늘', '국가대표 출신 피트니스 트레이너. 체계적인 운동 프로그램으로 건강한 라이프스타일을 제안합니다.', 'https://api.dicebear.com/7.x/avataaars/svg?seed=junghaneul', '운동·피트니스', 15600, 7, 4.9, 1),
(6, 7, '홍지우', '내셔널 지오그래픽 사진작가. 감성적인 사진 촬영부터 후보정까지, 사진의 모든 것을 알려드립니다.', 'https://api.dicebear.com/7.x/avataaars/svg?seed=hongjiwoo', '사진·영상', 9300, 4, 4.6, 1),
(7, 9, '양승현', '연매출 100억 쇼핑몰 대표. 실전 창업과 마케팅 노하우를 공유합니다.', 'https://api.dicebear.com/7.x/avataaars/svg?seed=yangsh', '비즈니스·마케팅', 11000, 6, 4.7, 1),
(8, 10, '신유리', 'JLPT N1, HSK 6급 보유. 10년간 다국어 강의 경험. 실생활에 바로 쓰는 외국어를 알려드립니다.', 'https://api.dicebear.com/7.x/avataaars/svg?seed=shinyuri', '외국어·어학', 14200, 9, 4.8, 1);

-- Categories
INSERT OR IGNORE INTO categories (id, name, slug, icon, description, sort_order) VALUES
(1, '드로잉·일러스트', 'drawing', 'fa-palette', '감성 드로잉부터 디지털 일러스트까지', 1),
(2, '프로그래밍·개발', 'programming', 'fa-code', '코딩 입문부터 실전 프로젝트까지', 2),
(3, '요리·베이킹', 'cooking', 'fa-utensils', '홈쿡 레시피부터 전문 셰프 클래스까지', 3),
(4, '음악·악기', 'music', 'fa-music', '악기 연주부터 작곡, 프로듀싱까지', 4),
(5, '운동·피트니스', 'fitness', 'fa-dumbbell', '홈트레이닝부터 전문 운동까지', 5),
(6, '사진·영상', 'photo', 'fa-camera', '촬영 기법부터 편집, 색보정까지', 6),
(7, '비즈니스·마케팅', 'business', 'fa-briefcase', '창업, 마케팅, 재테크, 부업', 7),
(8, '외국어·어학', 'language', 'fa-language', '영어, 일본어, 중국어 등 실전 회화', 8),
(9, '라이프스타일', 'lifestyle', 'fa-heart', '뷰티, 인테리어, 가드닝, 반려동물', 9),
(10, '디자인·공예', 'design', 'fa-gem', 'UX/UI, 그래픽, 핸드메이드 공예', 10);

-- Classes
INSERT OR IGNORE INTO classes (id, title, slug, subtitle, description, thumbnail, instructor_id, category_id, level, class_type, price, original_price, discount_percent, duration_minutes, total_lessons, max_students, current_students, rating, review_count, is_bestseller, is_new, is_subscription, schedule_start, tags, what_you_learn, requirements) VALUES
(1, '감성 수채화 일러스트 입문', 'watercolor-illustration', '하루 30분, 나만의 감성 일러스트를 완성해보세요', '수채화의 기본 기법부터 감성적인 일러스트 완성까지. 초보자도 쉽게 따라할 수 있는 단계별 커리큘럼으로 구성했습니다. 매 수업마다 하나의 작품을 완성하며 실력을 키워보세요.', 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=600&h=400&fit=crop', 1, 1, 'beginner', 'live', 89000, 129000, 31, 120, 24, 30, 28, 4.9, 342, 1, 0, 1, '2026-03-01 19:00:00', '수채화,일러스트,드로잉,입문,취미', '기본 수채화 기법 마스터|다양한 색 혼합과 그라데이션|감성적인 일러스트 완성|나만의 작품 포트폴리오 제작', '별도 준비물 불필요 (키트 제공)'),

(2, '실전 React & Next.js 마스터클래스', 'react-nextjs-master', '현업 개발자가 알려주는 실무 웹 개발', 'React와 Next.js를 활용한 실전 웹 개발 과정입니다. 포트폴리오에 바로 활용할 수 있는 프로젝트를 함께 만들며, 취업과 이직에 필요한 실무 역량을 키워보세요.', 'https://images.unsplash.com/photo-1633356122544-f134324a6cee?w=600&h=400&fit=crop', 2, 2, 'intermediate', 'live', 149000, 220000, 32, 180, 36, 50, 47, 4.8, 567, 1, 0, 1, '2026-03-05 20:00:00', 'React,Next.js,웹개발,프론트엔드,취업', 'React 핵심 개념 완벽 이해|Next.js App Router 실전 활용|TypeScript 실무 패턴|풀스택 프로젝트 완성', 'JavaScript 기초 문법 이해'),

(3, '프렌치 디저트 홈베이킹', 'french-dessert-baking', '르 코르동 블루 셰프의 시그니처 레시피', '마카롱, 크루아상, 에클레어 등 프랑스 정통 디저트를 집에서도 완벽하게 만들 수 있습니다. 재료 선택부터 플레이팅까지, 프로 셰프의 노하우를 담았습니다.', 'https://images.unsplash.com/photo-1558024920-b41e1887dc32?w=600&h=400&fit=crop', 3, 3, 'beginner', 'live', 79000, 110000, 28, 90, 18, 25, 23, 4.7, 234, 0, 1, 1, '2026-03-10 14:00:00', '베이킹,디저트,마카롱,프렌치,홈베이킹', '프렌치 디저트 기본 기법|마카롱 & 크루아상 완벽 레시피|프로급 플레이팅 스킬|카페 창업 노하우', '오븐 사용 가능한 환경'),

(4, '어쿠스틱 기타 완전정복', 'acoustic-guitar-master', '코드 3개로 시작하는 기타 여행', '기타를 처음 잡는 분들도 OK! 코드 잡는 법부터 핑거스타일까지, 단계별로 차근차근 알려드립니다. 좋아하는 노래를 직접 연주하는 감동을 느껴보세요.', 'https://images.unsplash.com/photo-1510915361894-db8b60106cb1?w=600&h=400&fit=crop', 4, 4, 'beginner', 'live', 69000, 99000, 30, 60, 20, 20, 18, 4.8, 189, 0, 0, 1, '2026-03-08 18:00:00', '기타,어쿠스틱,음악,입문,연주', '기본 코드와 스트로크 패턴|핑거스타일 주법 입문|인기곡 5곡 완곡|나만의 연주 영상 제작', '기타 1대 (어쿠스틱 권장)'),

(5, '4주 바디 체인지 프로그램', 'body-change-4weeks', '국가대표 트레이너의 과학적 홈트', '과학적 근거에 기반한 4주 집중 운동 프로그램입니다. 체중 감량, 근력 강화, 유연성 향상까지 체계적으로 관리해드립니다. 실시간 자세 교정으로 효과를 극대화하세요.', 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=600&h=400&fit=crop', 5, 5, 'all', 'live', 59000, 89000, 34, 60, 28, 40, 38, 4.9, 892, 1, 0, 1, '2026-02-28 07:00:00', '운동,홈트,다이어트,피트니스,체형교정', '체계적인 4주 운동 루틴|정확한 자세와 호흡법|식단 관리 가이드|실시간 1:1 자세 교정', '운동 가능한 공간 (2m x 2m)'),

(6, '감성 사진 촬영 & 라이트룸 보정', 'photo-lightroom-master', '일상이 작품이 되는 사진의 비밀', '스마트폰부터 DSLR까지, 어떤 카메라로든 감성적인 사진을 찍는 방법을 알려드립니다. 촬영 기법과 라이트룸 보정을 함께 배워 완성도 높은 사진을 만들어보세요.', 'https://images.unsplash.com/photo-1452587925148-ce544e77e70d?w=600&h=400&fit=crop', 6, 6, 'beginner', 'live', 99000, 140000, 29, 90, 22, 30, 26, 4.6, 178, 0, 1, 1, '2026-03-15 15:00:00', '사진,촬영,라이트룸,보정,포토그래피', '빛과 구도의 기본 원리|인물·풍경·음식 촬영법|라이트룸 보정 마스터|SNS용 사진 편집 스킬', '카메라 or 스마트폰'),

(7, '월 1000만원 스마트스토어 창업', 'smartstore-startup', '0원에서 시작하는 이커머스 창업기', '네이버 스마트스토어를 활용한 온라인 쇼핑몰 창업 과정입니다. 상품 소싱부터 마케팅, 매출 극대화까지 실전 노하우를 모두 공개합니다.', 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=600&h=400&fit=crop', 7, 7, 'beginner', 'live', 129000, 180000, 28, 120, 30, 35, 33, 4.7, 456, 1, 0, 1, '2026-03-03 20:00:00', '창업,스마트스토어,이커머스,부업,마케팅', '스마트스토어 개설 & 세팅|상품 소싱 전략|SEO & 광고 마케팅|매출 1000만원 달성 로드맵', '노트북 또는 PC'),

(8, '비즈니스 일본어 JLPT N2 완성', 'business-japanese-n2', '3개월 만에 JLPT N2 합격하기', '실제 비즈니스 상황에서 사용하는 일본어를 중심으로, JLPT N2 합격까지 한번에 준비할 수 있는 과정입니다. 매 수업 실전 회화 연습이 포함되어 있습니다.', 'https://images.unsplash.com/photo-1528164344705-47542687000d?w=600&h=400&fit=crop', 8, 8, 'intermediate', 'live', 109000, 160000, 32, 90, 32, 25, 21, 4.8, 312, 0, 0, 1, '2026-03-12 19:00:00', '일본어,JLPT,비즈니스,회화,어학', 'JLPT N2 문법 & 어휘 완성|비즈니스 일본어 회화|면접 & 프레젠테이션 일본어|실전 모의시험 & 해설', 'JLPT N3 수준 또는 히라가나/카타카나 읽기 가능'),

(9, 'iPad 디지털 드로잉 마스터', 'ipad-digital-drawing', 'Procreate로 그리는 나만의 캐릭터', 'iPad와 Procreate를 활용한 디지털 드로잉 과정입니다. 기본 브러시 활용부터 캐릭터 디자인, 굿즈 제작까지 디지털 아티스트의 모든 것을 배워보세요.', 'https://images.unsplash.com/photo-1561998338-13ad7883b20f?w=600&h=400&fit=crop', 1, 1, 'beginner', 'live', 119000, 170000, 30, 120, 26, 30, 29, 4.9, 421, 1, 1, 1, '2026-03-06 20:00:00', '아이패드,프로크리에이트,디지털드로잉,캐릭터,굿즈', 'Procreate 완벽 활용법|캐릭터 디자인 기초~심화|이모티콘 & 굿즈 제작|수익화 전략', 'iPad + Apple Pencil'),

(10, 'Python으로 시작하는 AI 개발', 'python-ai-development', '비전공자도 할 수 있는 인공지능 입문', 'Python 기초부터 ChatGPT API 활용, 나만의 AI 서비스 만들기까지! 코딩 경험이 없어도 AI 시대에 필요한 개발 역량을 키울 수 있습니다.', 'https://images.unsplash.com/photo-1555949963-aa79dcee981c?w=600&h=400&fit=crop', 2, 2, 'beginner', 'live', 139000, 200000, 30, 150, 40, 50, 45, 4.8, 678, 1, 1, 1, '2026-03-02 19:00:00', 'Python,AI,인공지능,ChatGPT,코딩입문', 'Python 기초 프로그래밍|ChatGPT API 활용법|나만의 AI 챗봇 만들기|AI 서비스 배포하기', '노트북 또는 PC'),

(11, '비건 한식 쿠킹클래스', 'vegan-korean-cooking', '건강하고 맛있는 비건 한식의 세계', '전통 한식을 비건 스타일로 재해석한 레시피를 배워보세요. 건강한 식재료 선택부터 영양 균형까지, 맛과 건강을 모두 잡는 요리법을 알려드립니다.', 'https://images.unsplash.com/photo-1547592180-85f173990554?w=600&h=400&fit=crop', 3, 3, 'beginner', 'live', 69000, 99000, 30, 75, 16, 20, 15, 4.7, 145, 0, 1, 1, '2026-03-20 11:00:00', '비건,한식,요리,건강식,쿠킹', '비건 재료 기본 가이드|전통 한식 비건 레시피 12가지|영양 균형 식단 설계|비건 소스 & 양념 마스터', '기본 주방 도구'),

(12, '피아노 즉흥연주 입문', 'piano-improvisation', '코드 이론으로 시작하는 자유로운 연주', '악보 없이도 자유롭게 피아노를 연주할 수 있습니다. 코드 이론부터 즉흥 연주 테크닉까지, 음악의 진정한 즐거움을 경험해보세요.', 'https://images.unsplash.com/photo-1520523839897-bd0b52f945a0?w=600&h=400&fit=crop', 4, 4, 'intermediate', 'live', 89000, 130000, 32, 60, 18, 15, 13, 4.8, 167, 0, 0, 1, '2026-03-18 19:30:00', '피아노,즉흥연주,코드,음악이론,재즈', '코드 이론 완벽 이해|리드 시트 읽는 법|장르별 즉흥 연주 패턴|나만의 어레인지 만들기', '피아노 or 키보드 악기');

-- Lessons (Curriculum for first few classes)
INSERT OR IGNORE INTO lessons (id, class_id, chapter_title, title, duration_minutes, sort_order, is_preview, lesson_type) VALUES
-- Class 1: 수채화
(1, 1, '기초 다지기', '수채화 재료 소개와 기본 세팅', 15, 1, 1, 'live'),
(2, 1, '기초 다지기', '물 조절과 붓 다루기', 20, 2, 0, 'live'),
(3, 1, '기초 다지기', '기본 색 혼합 이론', 20, 3, 0, 'live'),
(4, 1, '테크닉 익히기', '웻 온 웻 기법 실습', 25, 4, 0, 'live'),
(5, 1, '테크닉 익히기', '그라데이션과 번지기 효과', 25, 5, 0, 'live'),
(6, 1, '작품 완성하기', '꽃 일러스트 그리기', 30, 6, 0, 'live'),
(7, 1, '작품 완성하기', '풍경 일러스트 완성', 30, 7, 0, 'live'),
-- Class 2: React
(8, 2, 'React 기초', 'React 개발환경 세팅', 20, 1, 1, 'live'),
(9, 2, 'React 기초', 'JSX와 컴포넌트 이해', 25, 2, 0, 'live'),
(10, 2, 'React 기초', 'State와 Props 완벽 이해', 30, 3, 0, 'live'),
(11, 2, 'React 심화', 'Hooks 마스터하기', 30, 4, 0, 'live'),
(12, 2, 'React 심화', '전역 상태 관리 전략', 25, 5, 0, 'live'),
(13, 2, 'Next.js 입문', 'Next.js App Router 시작하기', 30, 6, 1, 'live'),
(14, 2, 'Next.js 입문', '서버 컴포넌트와 데이터 페칭', 35, 7, 0, 'live'),
(15, 2, '실전 프로젝트', '풀스택 프로젝트 기획', 30, 8, 0, 'live'),
(16, 2, '실전 프로젝트', 'API 설계와 구현', 35, 9, 0, 'live'),
-- Class 5: 운동
(17, 5, '1주차: 기초 체력', 'OT & 체력 측정', 15, 1, 1, 'live'),
(18, 5, '1주차: 기초 체력', '전신 스트레칭 루틴', 20, 2, 0, 'live'),
(19, 5, '1주차: 기초 체력', '기초 근력 운동 A', 25, 3, 0, 'live'),
(20, 5, '2주차: 근력 강화', '상체 집중 트레이닝', 25, 4, 0, 'live'),
(21, 5, '2주차: 근력 강화', '하체 집중 트레이닝', 25, 5, 0, 'live'),
(22, 5, '3주차: 유산소', 'HIIT 전신 운동', 30, 6, 0, 'live'),
(23, 5, '3주차: 유산소', '유산소 + 코어 복합운동', 30, 7, 0, 'live'),
(24, 5, '4주차: 마무리', '고강도 서킷 트레이닝', 30, 8, 0, 'live'),
(25, 5, '4주차: 마무리', '최종 체력 측정 & 리뷰', 20, 9, 0, 'live');

-- Reviews
INSERT OR IGNORE INTO reviews (id, class_id, user_id, rating, content, created_at) VALUES
(1, 1, 8, 5, '수채화를 처음 해봤는데 선생님이 너무 친절하게 알려주셔서 좋았어요! 완성된 작품 보고 감동했습니다.', '2026-01-15 10:30:00'),
(2, 2, 8, 5, '실무에서 바로 쓸 수 있는 내용이라 정말 유익했습니다. 포트폴리오도 완성했어요!', '2026-01-20 14:20:00'),
(3, 5, 8, 5, '4주 프로그램 끝나고 체중 3kg 감량, 근력도 확실히 늘었어요. 실시간 교정이 최고!', '2026-02-01 08:00:00'),
(4, 1, 8, 4, '재료 키트까지 같이 와서 편했어요. 다만 조금 더 심화 과정도 있었으면 좋겠습니다.', '2026-01-18 16:45:00'),
(5, 7, 8, 5, '실제로 스마트스토어 개설해서 첫 매출 달성했습니다! 실전 노하우가 가득해요.', '2026-02-05 20:10:00'),
(6, 10, 8, 5, 'Python 완전 초보였는데 AI 챗봇까지 만들 수 있게 되었어요. 설명이 정말 쉬워요!', '2026-02-08 11:30:00'),
(7, 9, 8, 5, 'iPad로 이모티콘 만들어서 실제로 판매 시작했습니다. 인생 클래스!', '2026-01-25 19:00:00'),
(8, 4, 8, 4, '기타 코드 잡는 게 어려웠는데 선생님이 라이브로 바로바로 교정해주셔서 좋았어요.', '2026-01-28 21:15:00');
