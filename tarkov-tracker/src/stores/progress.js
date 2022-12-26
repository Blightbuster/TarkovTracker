import { defineStore } from 'pinia'
import { useLiveData } from '@/composables/livedata'
import { computed } from 'vue'
import { useTarkovStore } from '@/stores/tarkov'
import { useUserStore } from '@/stores/user'
import { fireuser } from '@/plugins/firebase'
import { useTarkovData } from '@/composables/tarkovdata'

const { teammateStores } = useLiveData()
const userStore = useUserStore()
const { tasks, traders, hideoutStations, hideoutModules } = useTarkovData()

const gameEditions = [
  { version: 1, value: 0.0, defaultStashLevel: 1 },
  { version: 2, value: 0.0, defaultStashLevel: 2 },
  { version: 3, value: 0.2, defaultStashLevel: 3 },
  { version: 4, value: 0.2, defaultStashLevel: 4 },
]

export const useProgressStore = defineStore('progress', () => {
  const teamStores = computed(() => {
    let stores = {}
    stores['self'] = useTarkovStore()
    for (const teammate of Object.keys(teammateStores.value)) {
      stores[teammate] = teammateStores.value[teammate]()
    }
    return stores
  })

  const visibleTeamStores = computed(() => {
    let visibleStores = {}
    if (teamStores.value) {
      Object.entries(teamStores.value).forEach(([teamId, store]) => {
        if (!userStore.teamIsHidden(teamId)) {
          visibleStores[teamId] = store
        }
      })
    }
    return visibleStores
  })

  const tasksCompletions = computed(() => {
    // For each task, check if it is completed for each team member
    let completions = {}
    for (const task of tasks.value) {
      completions[task.id] = {}
      for (const teamId of Object.keys(teamStores.value)) {
        completions[task.id][teamId] = teamStores.value[teamId].isTaskComplete(task.id)
      }
    }
    return completions
  })

  const traderRep = computed(() => {
    let rep = {}
    for (const teamId of Object.keys(teamStores.value)) {
      rep[teamId] = {}
      // Loop through each task and add the rep to the total for each trader
      for (const task of tasks.value) {
        // If the task is marked as complete, add the rep to the total
        if (tasksCompletions.value[task.id][teamId]) {
          // Check if there are any traderStanding rewards
          if (task?.finishRewards?.traderStanding?.length > 0) {
            for (const traderStanding of task.finishRewards.traderStanding) {
              rep[teamId][traderStanding.trader.id] = rep[teamId]?.[traderStanding.trader.id] + traderStanding.standing || traderStanding.standing
            }
          }
        }
      }
      // Now add any rep from the game version
      for (const teamId of Object.keys(teamStores.value)) {
        // Find the gameEdition object with a version that matches the game edition
        let bonus = gameEditions.find((edition) => edition.version === teamStores.value[teamId].gameEdition)?.value || 0.0
        // For each trader, loop through and add the rep
        if (traders.value) {
          for (const trader of traders.value) {
            // Add the game edition value to the total
            rep[teamId][trader.id] = rep[teamId]?.[trader.id] + bonus || bonus
          }
        }
      }
    }
    return rep
  })

  const gameEditionData = computed(() => {
    return gameEditions
  })

  const traderLevelsAchieved = computed(() => {
    let levels = {}
    // Figure out which tier each user is at for each trader
    for (const teamId of Object.keys(teamStores.value)) {
      levels[teamId] = {}
      // For each trader, loop through the tiers and check if the user has met the requirements
      if (!traders.value) continue
      for (const trader of traders.value) {
        levels[teamId][trader.id] = 1
        if (trader?.levels.length > 0) {
          for (const level of trader.levels) {
            // Check if the user has enough reputation
            if (traderRep.value[teamId]?.[trader.id] >= level.requiredReputation) {
              // Check if the user is high enough level
              if (teamStores.value[teamId].playerLevel >= level.requiredPlayerLevel) {
                // If these conditions are met, check if the level is higher than the current level
                if (level.level > levels[teamId][trader.id]) {
                  levels[teamId][trader.id] = level
                }
              }
            }
          }
        }
      }
    }
    return levels
  })

  const unlockedTasks = computed(() => {
    // For each task, check if any team member has it available
    let available = {}
    for (const task of tasks.value) {
      available[task.id] = {}
      for (const teamId of Object.keys(teamStores.value)) {
        // Check if the task is already marked as complete for this team member
        if (tasksCompletions.value[task.id][teamId]) {
          available[task.id][teamId] = false
          continue
        }
        // Check if the parent tasks are marked as complete for this team member
        if (task.parents) {
          let parentTasksComplete = true
          for (const parentTaskId of task.parents) {
            if (!tasksCompletions.value[parentTaskId][teamId]) {
              parentTasksComplete = false
              break
            }
          }
          if (!parentTasksComplete) {
            available[task.id][teamId] = false
            continue
          }
        }
        // If we aren't already marked as false, check if the player has met the level requirement
        if (task?.minPlayerLevel && task?.minPlayerLevel > 0) {
          if (teamStores.value[teamId].playerLevel < task.minPlayerLevel) {
            available[task.id][teamId] = false
            continue
          }
        }
        // If we aren't already marked as false, check if the trader has met the level requirement
        if (task?.traderLevelRequirements?.length > 0) {
          // For each requirement, check if the trader is at the required level
          let traderLevelsMet = true
          for (const requirement of task.traderLevelRequirements) {
            if (traderLevelsAchieved.value[teamId]?.[requirement.trader.id] < requirement.level) {
              traderLevelsMet = false
              break
            }
          }
          if (!traderLevelsMet) {
            available[task.id][teamId] = false
            continue
          }
        }
        // If we aren't already marked as false, the task is available
        available[task.id][teamId] = true
      }
    }
    return available
  })

  const levelAppropriateTasks = computed(() => {
    // For each task, check if any team member has it available
    let available = {}
    if (!unlockedTasks.value) return {}
    for (const task of unlockedTasks.value) {
      available[task.id] = {}
      for (const teamId of Object.keys(teamStores.value)) {
        // Check if the task is unlocked for this team member
        if (!unlockedTasks.value[task.id][teamId]) {
          available[task.id][teamId] = false
          continue
        }
        // Check if the task is level appropriate for this team member
        if (task?.minPlayerLevel && task?.minPlayerLevel > 0) {
          if (teamStores.value[teamId].playerLevel < task.minPlayerLevel) {
            available[task.id][teamId] = false
            continue
          }
        }
        // If we aren't already marked as false, the task is available
        available[task.id][teamId] = true
      }
    }
    return available
  })

  const objectiveCompletions = computed(() => {
    // For each objective, check if it is completed for each team member
    let completions = {}
    for (const task of tasks.value) {
      for (const objective of task.objectives) {
        completions[objective.id] = {}
        for (const teamId of Object.keys(teamStores.value)) {
          completions[objective.id][teamId] = teamStores.value[teamId].isTaskObjectiveComplete(objective.id)
        }
      }
    }
    return completions
  })

  const moduleCompletions = computed(() => {
    // For each module, check if it is completed for each team member
    let completions = {}
    if (!hideoutModules.value) return {}
    for (const hModule of hideoutModules.value) {
      completions[hModule.id] = {}
      for (const teamId of Object.keys(teamStores.value)) {
        completions[hModule.id][teamId] = teamStores.value[teamId].isHideoutModuleComplete(hModule.id)
      }
    }
    return completions
  })

  const stationLevels = computed(() => {
    let stationLevelTemp = {}
    // For each station, check if we have marked it as built
    hideoutStations.value.forEach(station => {
      stationLevelTemp[station.id] = {}
      for (const teamId of Object.keys(teamStores.value)) {
        stationLevelTemp[station.id][teamId] = 0
        // Check if were the stash station, and if so, set the default level according to the game edition
        if (station.id == '5d484fc0654e76006657e0ab') {
          stationLevelTemp[station.id][teamId] = gameEditions.find(edition => edition.version == teamStores.value[teamId].gameEdition).defaultStashLevel
        }
        station.levels.forEach(level => {
          if (moduleCompletions.value?.[level.id]?.[teamId] && level.level > stationLevelTemp?.[station.id]?.[teamId]) {
            stationLevelTemp[station.id][teamId] = level.level
          }
        })
      }
    })
    return stationLevelTemp
  })

  const availableModules = computed(() => {
    let availableModules = {}
    // For each station, check if we have marked it as built
    hideoutStations.value.forEach(station => {
      station.levels.forEach(level => {
        availableModules[level.id] = {}
        for (const teamId of Object.keys(teamStores.value)) {
          // If the level is already built, it is not available
          if (moduleCompletions.value?.[level.id]?.[teamId]) {
            availableModules[level.id][teamId] = false
            continue
          }

          let userAvailable = true
          // For each requirement, check if the required module is built
          if (level?.stationLevelRequirements?.length > 0) {
            for (const requirement of level.stationLevelRequirements) {
              if (!moduleCompletions.value?.[requirement.station.id]?.[teamId]) {
                userAvailable = false
                break
              }
            }
          }
          availableModules[level.id][teamId] = userAvailable
        }
      })
    })
    return availableModules
  })

  const visibleStations = computed(() => {
    let visibleStations = {}
    // Loop through stationLevels and check load any station with a level > 0 on the 'self' teamstore
    for (const stationId of Object.keys(stationLevels.value)) {
      if (stationLevels.value[stationId]['self'] > 0) {
        visibleStations[stationId] = hideoutStations.value.find(station => station.id == stationId)
      }
    }

    // Loop through availableModules and load the relevant station if it is available
    for (const moduleId of Object.keys(availableModules.value)) {
      if (availableModules.value[moduleId]['self']) {
        // Find the station for this module
        const station = hideoutStations.value.find(station => station.levels.find(level => level.id == moduleId))
        if (station) {
          visibleStations[station.id] = station
        }
      }
    }

    return visibleStations
  })

  const getTeamIndex = function (teamId) {
    if (teamId == fireuser.uid) {
      return 'self'
    } else {
      return teamId
    }
  }

  const getDisplayName = function (teamId) {
    return teamStores.value[getTeamIndex(teamId)].getDisplayName || teamId.substring(0, 6)
  }

  const getLevel = function (teamId) {
    return this.teamStores[this.getTeamIndex(teamId)].playerLevel || 1
  }

  const teammemberNames = computed(() => {
    let names = {}
    //Return the displayNames of all visible team members
    for (const teamId of Object.keys(teamStores.value)) {
      names[teamId] = teamStores.value[getTeamIndex(teamId)].getDisplayName || teamId.substring(0, 6)
    }
    return names
  })

  return { teamStores, getDisplayName, getTeamIndex, visibleTeamStores, getLevel, teammemberNames, tasksCompletions, objectiveCompletions, unlockedTasks, levelAppropriateTasks, traderRep, traderLevelsAchieved, moduleCompletions, stationLevels, availableModules, visibleStations, gameEditionData }
})