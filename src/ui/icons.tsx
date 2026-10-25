// Иконки: Phosphor (react-icons, в сборке — офлайн) + свои: гиря и мини-степпер.
export {
  PiHouse, PiCalendarBlank, PiForkKnife, PiShoppingCart, PiCookingPot, PiChartLineUp, PiChatsCircle, PiGear, PiSquaresFour,
  PiCheckBold, PiCheck, PiX, PiPlus, PiMinus, PiCaretLeft, PiCaretRight, PiCaretDown, PiCaretUp, PiTrash, PiPencilSimple,
  PiDownloadSimple, PiUploadSimple, PiCopy, PiShieldCheck, PiWarning, PiInfo, PiPlay, PiPause, PiStop, PiArrowCounterClockwise,
  PiPrinter, PiShareNetwork, PiListChecks, PiFileZip, PiLock, PiPersonSimpleWalk, PiClock, PiImages, PiCamera,
  PiCalendarCheck, PiSnowflake, PiThermometer, PiBookOpen, PiMagnifyingGlass, PiArrowsClockwise, PiDotsThreeBold, PiSun,
  PiScales, PiPackage, PiArrowsLeftRight, PiSkipForward, PiCloudSlash, PiSparkle, PiLeaf, PiDrop, PiCalendarPlus, PiHeartbeat,
  PiArrowRight, PiFlame, PiNotePencil, PiEye, PiEyeSlash, PiTimer,
} from 'react-icons/pi';

type P = { size?: number; className?: string };

/** Гиря: дужка + шар. */
export function KettlebellIcon({ size = 24, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M8.2 9.2 7.6 6.6a3 3 0 0 1 2.9-3.6h3a3 3 0 0 1 2.9 3.6l-.6 2.6" />
      <circle cx="12" cy="14.6" r="6.4" />
      <path d="M9.2 20.2h5.6" />
    </svg>
  );
}

/** Мини-степпер: две педали на основании. */
export function StepperIcon({ size = 24, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 20h18" />
      <path d="M7 20l3-6" />
      <path d="M17 20l-3-6" />
      <path d="M4.5 8.5h6l-.8 2.5h-5z" />
      <path d="M13.5 12h6l-.8 2.5h-5z" />
    </svg>
  );
}
