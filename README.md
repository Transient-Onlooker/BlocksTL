# BlocksTL

브라우저에서 STL 모델을 여러 개의 조립식 블록으로 나누고, 고정 치수 핀과 실험적인 스프링 소켓을 생성하는 로컬 전용 도구입니다.

**Live app:** https://transient-onlooker.github.io/BlocksTL/

## What it does

BlocksTL은 하나의 STL을 Z축 방향으로 2~8개 블록으로 분할하고, 서로 맞닿는 절단면에 수핀과 암 스프링 소켓을 배치합니다. 생성 전에는 포인트 클라우드 Cut Preview를, 생성 중과 완료 후에는 실제 Boolean 결과의 위·아래·측면 투영을 보여줍니다.

STL 파일은 서버에 업로드되지 않습니다. 모든 파싱과 형상 처리는 브라우저 안의 Web Worker와 Manifold WASM에서 로컬로 수행됩니다.

## Features

- Binary/ASCII STL 불러오기
- Orthographic 포인트 클라우드 Cut Preview와 Z 분할 가이드
- 2~8개 블록 분할 지원 — 원본 영상의 권장 범위는 대략 3~7개
- 모델만 25~200%로 조절하는 Object Scale
- 고정 mm 치수의 tapered male pin과 Spring Socket V1
- 19/20/21 수핀 맞춤 단계와 출력용 fit-test coupon
- 생성되는 각 블록의 progressive QA 미리보기
- 블록별 STL 및 전체 ZIP 다운로드
- Generated Blocks 화면과 자유 회전 3D 점검 화면

## How it works

```text
Triangle mesh
  → Z slab split
  → interface multi-slice
  → 2D polygon footprint validation
  → fixed connector grid
  → male union / spring female Boolean
  → STL export
```

전체 모델을 3D voxel로 변환하지 않습니다. 원본 triangle mesh를 Manifold로 분할하고, 여러 Z slice에서 얻은 2D polygon 안에 실제 connector footprint가 안전하게 들어가는 위치만 선택합니다.

## Quick start

Node.js 22 이상과 npm이 필요합니다.

```bash
git clone https://github.com/Transient-Onlooker/BlocksTL.git
cd BlocksTL
npm install
npm run dev
```

터미널에 표시된 로컬 주소를 브라우저에서 여세요. 설치 없이 사용하려면 위의 Live app을 이용할 수 있습니다.

## Usage

1. `STL 열기`로 모델을 불러옵니다.
2. 블록 개수와 출력 크기를 정하고 Cut Preview에서 분할 위치를 확인합니다.
3. 본 출력 전에 `19·20·21 맞춤 테스트 STL 만들기`로 작은 coupon을 출력합니다.
4. 프린터에 가장 적합한 핀 맞춤 단계를 선택합니다.
5. `블록 생성하기`를 누르고 Generated Blocks에서 핀·소켓과 외형을 확인합니다.
6. 개별 STL 또는 ZIP을 받아 슬라이서에서 출력합니다.

중요: **Object Scale은 모델 크기만 바꿉니다. Connector의 물리 치수와 간격은 실제 mm 단위로 고정되어 함께 확대·축소되지 않습니다.** 모델을 너무 작게 만들면 connector가 들어갈 공간이 부족해 생성이 제한될 수 있습니다.

## Connector fit calibration (19 / 20 / 21)

19/20/21은 수핀 지름만 조절하는 맞춤 단계입니다. 암 스프링 형상은 모든 단계에서 고정됩니다.

| 단계 | 수핀 지름 | 의미 |
|---:|---:|---|
| 19 | 5.8 mm | baseline male pin |
| 20 | 5.9 mm | baseline +0.1 mm |
| 21 | 6.0 mm | baseline +0.2 mm |

프린터, 노즐, 레이어 높이, 재료와 필라멘트 상태에 따라 실제 맞춤이 달라집니다. 본 모델을 생성하기 전에 coupon을 출력해 삽입력, 유격, 분리력과 반복 결합 시 백화·균열·영구 변형을 확인하세요.

**Spring Socket V1은 experimental 상태입니다.** 현재 숫자는 영상 관찰과 출력 보정을 위한 시작 추정치이며, 원본 프로그램의 공식 치수나 물리 검증이 끝난 최종값이 아닙니다.

## Architecture

- React + TypeScript + Vite: UI와 GitHub Pages 정적 빌드
- Three.js: Cut Preview와 3D 점검
- Web Worker: UI를 막지 않는 STL 파싱과 형상 생성
- Manifold WASM: mesh split, Boolean union/subtract와 manifold 결과 생성
- `fflate`: 브라우저 내 ZIP 패키징

브라우저가 STL 입력부터 결과 다운로드까지 담당하며 백엔드, 계정, 업로드 저장소가 없습니다. 상세 설계와 역공학 기록은 [BlocksTL.md](./BlocksTL.md)를 참고하세요.

## Development

```bash
npm install
npm run dev
```

프로덕션 빌드와 로컬 미리보기:

```bash
npm run build
npm run preview
```

`master` 또는 `main`에 push하면 GitHub Actions가 빌드와 회귀 검증을 통과한 결과만 GitHub Pages에 배포합니다.

## Verification / Tests

```bash
npm run verify:stl
npm run verify:geometry
```

- `verify:stl`: exact/trailing Binary STL, truncated Binary 거부, 대소문자 ASCII vertex, numeric vertex welding 검사
- `verify:geometry`: 19/20/21 coupon, 3-way cube split, 중간 블록의 양면 connector, cylinder 안전 영역, thin-neck 거부 검사

CI는 `npm ci → npm run build → npm run verify:stl → npm run verify:geometry → deploy` 순서로 실행하며 하나라도 실패하면 Pages를 배포하지 않습니다.

## Browser & performance notes

- 최신 Chromium, Firefox, Safari처럼 WebAssembly와 Web Worker를 지원하는 브라우저를 권장합니다.
- 형상 생성은 CPU·메모리 집약적이며 입력의 파일 크기보다 triangle 수와 Boolean 복잡도에 더 크게 좌우됩니다.
- 큰 모델은 먼저 낮은 블록 수로 시험하고, 생성 중에는 탭을 닫거나 새 파일을 불러오지 마세요.
- 100 MB 이상 입력의 peak JS heap/WASM memory와 브라우저 응답성은 아직 체계적인 benchmark를 완료하지 않았습니다.

## Current limitations

- Spring 치수는 아직 최종 물리 검증값이 아닙니다.
- 매우 큰 STL 생성은 상당한 JS/WASM 메모리를 사용할 수 있습니다.
- ASCII STL 파서는 현재 파일 전체를 문자열로 디코딩합니다.
- non-manifold, self-intersecting 또는 병적인 STL은 Manifold 변환이나 Boolean에서 실패할 수 있습니다.
- 영상만으로는 원본 connector의 정확한 topology와 치수를 확정할 수 없습니다.
- 브라우저에서 STL을 직접 생성하므로 기기 성능에 따라 처리 시간이 크게 달라집니다.

## Reverse-engineering status

BlocksTL은 참고 영상에 나온 동작을 독립적으로 재현하는 **functional reverse-engineering project**입니다. 원본 실행 파일이나 자산을 복제한 것이 아니며, connector dimensions are experimental estimates, not confirmed original dimensions.

현재 Cut Preview, 고정 치수 connector 배치, Spring Socket V1, Generated Blocks QA와 STL/ZIP 출력까지 구현됐습니다. 영상과의 기능적 패리티를 우선하며, 현재 제품 UI는 사용성을 위해 독자적인 형태를 유지합니다.

## Roadmap

1. PLA 19/20/21 coupon의 삽입력·유격·분리력·10/20/50회 내구성 기록
2. 실제 출력 데이터에 근거한 connector profile V2 결정
3. 10/50/100/150~200 MB급 STL load/generation 메모리 benchmark
4. `solid` binary header, NaN/Infinity, zero-area, multi-shell, non-manifold 입력 corpus 확장
5. 필요할 경우 선택적인 Replica theme 검토

## License / Attribution

이 저장소에는 아직 명시적인 오픈소스 라이선스 파일이 없습니다. 라이선스가 추가되기 전에는 코드를 임의로 재배포할 권한이 부여된 것으로 간주하지 마세요.

BlocksTL은 참고 영상의 “Amazing Toys Creator: Building Blocks” 워크플로에서 영감을 받은 독립 구현입니다. 원본 프로그램의 코드, 실행 파일, 브랜드 자산은 포함하지 않습니다.
