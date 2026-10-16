// Station list demo (deliberately messy)
var stations = [
  { name: "Tokyo", active: true, passengers: 120 },
  { name: "Osaka", active: false, passengers: 80 },
  { name: "Nagoya", active: true, passengers: 45 },
];

var stn = document.getElementById("open-btn");

function isBusy(count) {
  return count > 100;
}

function render(list) {
  const activeStations = stations.filter((station) => station.active);
  const ul = document.getElementById("station-list");
  let html = "";
  for (var i = 0; i < activeStations.length; i++) {
    html += `<li class="station-item active">${activeStations[i].name}</li>`;
  }
  ul.innerHTML = html;
  return activeStations;
}

function totalPassengers() {
  return stations.reduce((a, station) => a + station.passengers, 0);
}

function openStation() {
  const res = render(stations);
  if (res.length) {
    console.log("open", totalPassengers());
  } else if (isBusy(totalPassengers())) {
    console.log("busy");
  }
}

stn.addEventListener("click", openStation);
