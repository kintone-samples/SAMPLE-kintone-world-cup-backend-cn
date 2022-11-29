/* eslint-disable no-restricted-syntax */
import { KintoneRestAPIClient } from '@kintone/rest-api-client'
import { DateTime } from 'luxon'
import { appList, matchInfoField, usersField, userChipInField, scoreField } from './config'
// 比赛及赔率信息(matchInfo) 的自定义开发
// 获取当前场次所有的投注。依次根据创建者进行分类。
// 循环处理每个人的投注
// 每个人的投注判断：1 是否超过投注时间。（创建时间超过截止时间）2 是否存在多条投注 3 获取他的所有未生效投注并和剩余积分比较。是否有超过。
// 如果是正常投注，则计算猜对的投注的积分，更新用户的积分履历，用户积分，投注的积分结果
const client = new KintoneRestAPIClient()

const getChipInListByMatchId = (matchId) => {
  const params = {
    app: appList.userChipIn,
    query: `${matchInfoField.Match_id} = ${matchId}`,
  }
  return client.record.getRecords(params)
}
// 获取用户已经生效的总积分
const GetEffectiveSocre = async (createrUser) => {
  const app = appList.users
  const params = {
    app,
    query: `${usersField.User} in (${createrUser})`,
  }
  const resp = await client.record.getRecords(params)
  return Number(resp.records[0][usersField.Score].value)
}

// 获取未开奖记录（冻结的积分）
const GetFreezeScore = async (createrUser) => {
  const app = appList.userChipIn
  const params = {
    app,
    query: `${userChipInField.Create_user} in (${createrUser}) and ${userChipInField.Score_result} =0`,
  }
  const resp = await client.record.getRecords(params)
  let freezeScore = 0
  for (const value of resp.records) {
    freezeScore += Number(value[userChipInField.Chip_in_score].value)
  }
  return freezeScore
}

// 获取用户当前可使用积分（总积分-未生效投注历史即积分结果为0的记录）
const GetLeftScore = async (createrUser) => {
  const effectiveSocre = await GetEffectiveSocre(createrUser)
  const freezeScore = await GetFreezeScore(createrUser)
  const leftScore = effectiveSocre - freezeScore
  return leftScore
}

// 更新竞猜记录的积分结果(条件：场次，人)处理结果1条
const updateSocreResult = async (createrUser, matchId, scoreResult) => {
  const app = appList.userChipIn
  const params = {
    app,
    query: `${userChipInField.Create_user} in (${createrUser}) and ${userChipInField.Match_id} = ${matchId}`,
  }
  const list = await client.record.getRecords(params)
  const updateId = list.records[0].$id.value
  const updateInfo = {
    app,
    id: updateId,
    record: {
      [userChipInField.Score_result]: {
        value: scoreResult,
      },
    },
  }
  // console.log(updateInfo)
  await client.record.updateRecord(updateInfo)
}

// 更新用户的积分总数 (条件：人) 处理结果1条
const updateUserSocre = async (createrUser, diffScore) => {
  const app = appList.users
  const params = {
    app,
    query: `${usersField.User} in (${createrUser})`,
  }
  const list = await client.record.getRecords(params)
  const updateId = list.records[0].$id.value
  const newScore = Number(list.records[0][usersField.Score].value) + diffScore
  const updateInfo = {
    app,
    id: updateId,
    record: {
      [usersField.Score]: {
        value: newScore,
      },
    },
  }
  // console.log(updateInfo)
  await client.record.updateRecord(updateInfo)
}

// 添加积分履历
const addSocreList = async (records) => {
  const app = appList.score
  const params = {
    app,
    records,
  }
  await client.record.addRecords(params)
}

kintone.events.on('app.record.detail.show', async (event) => {
  if (document.getElementById('score') !== null) {
    return event
  }
  const { record } = event
  const matchId = record[matchInfoField.Match_id].value

  const button = document.createElement('button')
  button.id = 'score'
  button.classList.add('kintoneplugin-button-normal')
  button.innerText = '一键开奖'
  button.onclick = () => {
    getChipInListByMatchId(matchId).then(async (resp) => {
      // console.log(resp.records)
      const list = resp.records
      const userList = []
      const newList = list.filter((item) => {
        const createTime = item[userChipInField.Create_time].value
        const deadLine = record[matchInfoField.Deadline].value
        const createrUser = item[userChipInField.Create_user].value.code
        const deadLineObj = DateTime.fromISO(deadLine)
        const createTimeObj = DateTime.fromISO(createTime)
        if (deadLineObj < createTimeObj) {
          return false
        }
        if (userList.indexOf(createrUser) >= 0) {
          return false
        }
        userList.push(createrUser)
        return true
      })
      // console.log(newList)
      const oddsMapping = {
        A胜B: matchInfoField.OddsA,
        A平B: matchInfoField.OddsC,
        A负B: matchInfoField.OddsB,
      }
      const result = record[matchInfoField.Result].value
      const oddChoose = oddsMapping[result]
      const oddValue = Number(record[oddChoose].value)

      for (const item of newList) {
        const createrUser = item[userChipInField.Create_user].value.code
        const userChipInType = item[userChipInField.Chip_in_type].value
        const userChipInScore = Number(item[userChipInField.Chip_in_score].value)
        const leftScore = await GetLeftScore(createrUser)
        if (leftScore > 0) {
          let gotScore = 0
          let scoreResult = 0
          let diffScore = 0
          // 更新用户积分，积分履历,以及积分结果（选错就是-押注分）
          const addRecords = [
            {
              [scoreField.User]: {
                value: [
                  {
                    code: createrUser,
                  },
                ],
              },
              [scoreField.Match_id]: record[matchInfoField.Match_id],
              [scoreField.Score]: { value: userChipInScore * -1 },
              [scoreField.Type]: { value: 'chipIn' },
            },
          ]
          if (userChipInType === result) {
            gotScore = userChipInScore * oddValue
            scoreResult = gotScore
            diffScore = gotScore - userChipInScore
            console.log(diffScore)
            const scoreObj = {
              [scoreField.User]: {
                value: [
                  {
                    code: createrUser,
                  },
                ],
              },
              [scoreField.Match_id]: record[matchInfoField.Match_id],
              [scoreField.Score]: { value: scoreResult },
              [scoreField.Type]: { value: 'win' },
            }
            addRecords.push(scoreObj)
          } else {
            scoreResult = userChipInScore * -1
            diffScore = scoreResult
          }
          console.log(addRecords)
          await updateSocreResult(createrUser, matchId, scoreResult)
          await updateUserSocre(createrUser, diffScore)
          await addSocreList(addRecords)
          // 积分计算：先减去下注，再加上赢取
          // 积分履历：包含下注，如果有赢取就加上
          // 积分结果：赢取就是赢取，输的话是下注*-1
          console.log(diffScore)
          // console.log(scoreResult)
        }
        // GetLeftScore(createrUser).then(async (leftScore) => {
        //   if (leftScore > 0) {
        //     let gotScore = 0
        //     let scoreResult = 0
        //     // 更新用户积分，积分履历,以及积分结果（选错就是-押注分）
        //     if (userChipInType === result) {
        //       gotScore = userChipInScore * oddValue
        //       scoreResult = gotScore
        //     } else {
        //       scoreResult = userChipInScore * -1
        //     }
        //     await updateSocreResult(createrUser, matchId, scoreResult)

        //     // 积分计算：先减去下注，再加上赢取
        //     // 积分履历：包含下注，如果有赢取就加上
        //     // 积分结果：赢取就是赢取，输的话是下注*-1
        //     console.log(gotScore)
        //     console.log(scoreResult)
        //   }
        // })
        // if ()
      }
    })
    // setScore().then(() => {
    //   new swal("开奖完成", "开奖完成！", "success").then(() => {
    //     window.location.reload();
    //   });
    // });
  }
  kintone.app.record.getHeaderMenuSpaceElement().appendChild(button)
  return event
})
