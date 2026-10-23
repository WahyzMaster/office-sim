async (THREE, floor) => {
  // 데모 에이전트가 openElevator() 로 elevT 를 1.4 로 되돌리지 않게 막고 문을 끝까지 연 채로 둔다.
  floor.openElevator = () => {};
  floor.elevT = 1e9;
  floor.doorOpen = 1;
  await new Promise((r) => setTimeout(r, 400));
  return floor.doors.map((d) => [+d.position.x.toFixed(3), +d.position.z.toFixed(3), +d.scale.z.toFixed(3)]);
}
