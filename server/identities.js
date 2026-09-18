// Explicit cross-platform identities. Never match careers by a team name.
export const owners = [
  ["jake", "Jake Herman", "517403C9-362D-4CD6-B403-C9362DDCD61D", "867539446919245824"],
  ["dylan", "Dylan Healy", "8A51DA1F-87D5-4401-AC40-4ACE5CF09FCA", "1395782932001456128"],
  ["gaurav", "Gaurav Gandhi", "262EB0E5-0AFE-4A06-B51A-332B956ACD9D", "1388256616830238720"],
  ["zach", "Zach Jacobs", "45EACEF8-B6BA-4C17-AACE-F8B6BA5C1708", "994447211251412992"],
  ["kyle", "Kyle Emery", "D1D0479E-6B1C-46CA-9047-9E6B1C56CADA", null],
  ["alex", "Alex Henoch", "492B6C02-FE6E-462C-AB6C-02FE6E762CA9}+{7D0CEB2A-FD69-4B44-A332-D439AB4DECC1", "1398442998081073152"],
  ["harrison", "Harrison Gerber", "26A72411-1823-4B1B-A724-1118237B1BD4", "1269334262297939968"],
  ["will", "Will Hyland", "3356763A-D6CE-4DB9-9676-3AD6CE2DB996", "979413096693379072"],
  ["ben", "Ben Dross", "569E4D3A-028D-40F9-9E4D-3A028D30F977", "1091583031988600832"],
  ["ethan", "Ethan Miller", "A6004BB1-E7D6-4D5F-83DA-50A033574129", "1122221862504796160"],
  ["cameron", "Cameron Miller", "D1EEDEA8-F6A8-4E29-AEDE-A8F6A86E29F2", "1400182380202897408"],
  ["pyo-ethan-former", "Daniel Pyo / Ethan Miller (former)", "A21F6FA2-017B-48FD-9F6F-A2017B98FD12}+{E85F97AF-79BE-4E05-9F97-AF79BEDE0565", null],
  ["ben-stanish", "Ben Stanish", "6D47F049-4C8F-4067-87F0-494C8F80679B", null],
  ["zane", "Zane Begun", "DF8756B4-B134-43D2-8756-B4B134A3D2C8", null],
].map(([id, name, espnId, sleeperId]) => ({ id, name, espnKey: `owner:{${espnId}}`, sleeperId }));

export function linkCurrentOwners(snapshot) {
  return { ...snapshot, teams: snapshot.teams.map((team) => ({ ...team,
    canonicalOwnerIds: (team.ownerIds || []).map((id) => owners.find((owner) => owner.sleeperId === id)?.id || `sleeper:${id}`),
  })) };
}
