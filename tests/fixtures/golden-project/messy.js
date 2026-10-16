// Station list demo (deliberately messy)
var stations = [
  {name:"Tokyo", active:true, passengers: 120},
  {name:"Osaka", active:false, passengers: 80},
  {name:"Nagoya", active:true, passengers: 45}
];

var stn = document.getElementById('open-btn');

function isBusy(count){
  if (count > 100) { return true; } else { return false; }
}

function render(list){
  var x = stations.filter(s=>s.active);
  var ul = document.getElementById('station-list');
  var t = '';
  for (var i=0;i<x.length;i++){
    t += '<li class="station-item active">'+x[i].name+'</li>';
  }
  ul.innerHTML = t;
  return x;
}

function totalPassengers(){
  var r = stations.reduce((a,s)=>a+s.passengers,0);
  return r;
}

function openStation(){
  var res = render(stations);
  if (!!res.length) {
    console.log("open", totalPassengers());
  } else {
    if (isBusy(totalPassengers())) { console.log("busy"); }
  }
}

stn.addEventListener('click', openStation);
