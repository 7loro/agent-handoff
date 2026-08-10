# ahandoff — 최소 작업 명령

default:
    @just --list

# 의존성 설치
install:
    npm install

# TypeScript 빌드
build:
    npm run build

# 전역 설치 (ahf 명령 연결)
link: build
    npm install -g .

# 개발 실행 (tsx, 인자 전달: just run -- list --days 3)
run *args:
    npx tsx src/cli.ts {{args}}

# 목 데이터로 피커 실행 (디스크 스캔 없음)
#   just mock
mock *args:
    AH_MOCK=1 npx tsx src/cli.ts pick --mock {{args}}

# 빌드 산출물 삭제
clean:
    rm -rf dist
