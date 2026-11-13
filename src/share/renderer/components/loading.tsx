import { colorPrimary } from 'common/theme'

export interface ILoadingProps {
  className?: string
  onClick?: () => void
}

// 三根柱依次起伏：0s / 0.15s / 0.3s，总周期 0.6s
const BARS = [0, 8, 16]
const DELAYS = ['0s', '0.15s', '0.3s']

export const LoadingBar = (props: ILoadingProps) => (
  <svg
    version="1.1"
    id="Layer_1"
    xmlns="http://www.w3.org/2000/svg"
    x="0px"
    y="0px"
    className={props.className || ''}
    width="24px"
    height="30px"
    onClick={props.onClick}
    viewBox="0 0 24 30"
  >
    {BARS.map((x, i) => (
      <rect
        key={x}
        x={x}
        y="10"
        width="4"
        height="10"
        fill={colorPrimary}
        opacity="0.2"
      >
        <animate
          attributeName="opacity"
          attributeType="XML"
          values="0.2; 1; .2"
          begin={DELAYS[i]}
          dur="0.6s"
          repeatCount="indefinite"
        />
        <animate
          attributeName="height"
          attributeType="XML"
          values="10; 20; 10"
          begin={DELAYS[i]}
          dur="0.6s"
          repeatCount="indefinite"
        />
        <animate
          attributeName="y"
          attributeType="XML"
          values="10; 5; 10"
          begin={DELAYS[i]}
          dur="0.6s"
          repeatCount="indefinite"
        />
      </rect>
    ))}
  </svg>
)

export const LoadingCircle = function (props: ILoadingProps) {
  return (
    <svg
      version="1.1"
      id="loader-1"
      xmlns="http://www.w3.org/2000/svg"
      x="0px"
      y="0px"
      className={props.className || ''}
      width="40px"
      height="40px"
      viewBox="0 0 50 50"
      onClick={props.onClick}
    >
      <path
        fill={colorPrimary}
        d="M25.251,6.461c-10.318,0-18.683,8.365-18.683,18.683h4.068c0-8.071,6.543-14.615,14.615-14.615V6.461z"
      >
        <animateTransform
          attributeType="xml"
          attributeName="transform"
          type="rotate"
          from="0 25 25"
          to="360 25 25"
          dur="0.6s"
          repeatCount="indefinite"
        ></animateTransform>
      </path>
    </svg>
  )
}
