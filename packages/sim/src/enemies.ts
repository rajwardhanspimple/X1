import * as fx from './math/fixed.js';
export interface EnemyArchetype { id:string; index:number; health:fx.Fx; speed:fx.Fx; sightRange:fx.Fx; preferredRange:fx.Fx; reactionTicks:number; fireIntervalTicks:number; damage:fx.Fx; accuracy:fx.Fx; scoreValue:number; telegraphTicks:number; }
export const ARCHETYPES: readonly EnemyArchetype[] = [
{id:'rusher',index:0,health:fx.fromInt(45),speed:fx.fromRatio(62*100,60*1000),sightRange:fx.fromInt(42),preferredRange:fx.fromInt(3),reactionTicks:16,fireIntervalTicks:26,damage:fx.fromInt(9),accuracy:fx.fromRatio(52,100),scoreValue:100,telegraphTicks:10},
{id:'rifleman',index:1,health:fx.fromInt(70),speed:fx.fromRatio(38*100,60*1000),sightRange:fx.fromInt(55),preferredRange:fx.fromInt(16),reactionTicks:24,fireIntervalTicks:42,damage:fx.fromInt(13),accuracy:fx.fromRatio(60,100),scoreValue:150,telegraphTicks:14},
{id:'heavy',index:2,health:fx.fromInt(160),speed:fx.fromRatio(26*100,60*1000),sightRange:fx.fromInt(38),preferredRange:fx.fromInt(9),reactionTicks:32,fireIntervalTicks:34,damage:fx.fromInt(17),accuracy:fx.fromRatio(46,100),scoreValue:250,telegraphTicks:20},
];
export function archetypeByIndex(index:number):EnemyArchetype{return ARCHETYPES[index]??ARCHETYPES[0]!;}
export const Brain={Idle:0,Advance:1,Engage:2,Retreat:3,Cover:4,Flank:5,Suppress:6,Search:7,Regroup:8} as const;
