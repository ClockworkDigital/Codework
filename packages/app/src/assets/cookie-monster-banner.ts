import genericLight from "./cookie-monster-banner-generic-light.svg"
import genericDark from "./cookie-monster-banner-generic-dark.svg"
import wppLight from "./cookie-monster-banner-light.svg"
import wppDark from "./cookie-monster-banner-dark.svg"

export const cookieMonsterBannerLight = import.meta.env.VITE_CM_WPP ? wppLight : genericLight
export const cookieMonsterBannerDark = import.meta.env.VITE_CM_WPP ? wppDark : genericDark
