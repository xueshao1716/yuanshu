// 配色卡的数据源在 engine/color-cards.mjs（主题页与创作流共用一份）。
//
// 为什么不在这里再写一遍色值：这两处一旦各存一份，改一边就会漂移——主题页显示一套色、
// 提示词里写的是另一套，谁也不知道哪个才是用户选的。这里只做转出，名字沿用前端的叫法。
export { COLOR_CARDS as MORANDI_CARDS, colorCardGradient, resolveColorCard } from '../../../engine/color-cards.mjs'
