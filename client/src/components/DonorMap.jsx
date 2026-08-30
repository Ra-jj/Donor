import React from 'react';
import { MapContainer, TileLayer, Marker, Popup, Circle } from 'react-leaflet';
import L from 'leaflet';

// Custom hospital pin (MapPinPlus style)
const hospitalIcon = L.divIcon({
  html: `<div style="color: #DC2626; display: flex; justify-content: center; align-items: center; filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.3));">
    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" fill="currentColor" viewBox="0 0 256 256">
      <path d="M128,16a88.1,88.1,0,0,0-88,88c0,75.3,80,132.17,83.41,134.55a8,8,0,0,0,9.18,0C136,236.17,216,179.3,216,104A88.1,88.1,0,0,0,128,16Zm0,206c-22.17-19.14-72-68.4-72-118a72,72,0,0,1,144,0C200,153.6,150.17,202.86,128,222ZM160,96H136V72a8,8,0,0,0-16,0V96H96a8,8,0,0,0,0,16h24v24a8,8,0,0,0,16,0V112h24a8,8,0,0,0,0-16Z"></path>
    </svg>
  </div>`,
  className: '', // Removes the default Leaflet divIcon styles
  iconSize: [36, 36],
  iconAnchor: [18, 36], // Point precisely at coordinate bottom-center
  popupAnchor: [0, -36]
});

// Custom donor pin
const donorIcon = L.divIcon({
  html: `<div style="color: #2563EB; display: flex; justify-content: center; align-items: center; filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));">
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" fill="currentColor" viewBox="0 0 256 256">
      <path d="M128,16a88.1,88.1,0,0,0-88,88c0,75.3,80,132.17,83.41,134.55a8,8,0,0,0,9.18,0C136,236.17,216,179.3,216,104A88.1,88.1,0,0,0,128,16Zm0,206c-22.17-19.14-72-68.4-72-118a72,72,0,0,1,144,0C200,153.6,150.17,202.86,128,222Z"></path>
    </svg>
  </div>`,
  className: '',
  iconSize: [28, 28],
  iconAnchor: [14, 28],
  popupAnchor: [0, -28]
});

// User's own pin (for dashboard)
const userIcon = L.divIcon({
  html: `<div style="color: #16A34A; display: flex; justify-content: center; align-items: center; filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));">
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" fill="currentColor" viewBox="0 0 256 256">
      <path d="M128,16a88.1,88.1,0,0,0-88,88c0,75.3,80,132.17,83.41,134.55a8,8,0,0,0,9.18,0C136,236.17,216,179.3,216,104A88.1,88.1,0,0,0,128,16Zm0,206c-22.17-19.14-72-68.4-72-118a72,72,0,0,1,144,0C200,153.6,150.17,202.86,128,222Z"></path>
    </svg>
  </div>`,
  className: '',
  iconSize: [28, 28],
  iconAnchor: [14, 28],
  popupAnchor: [0, -28]
});

const DonorMap = ({ 
  hospitalLocation, 
  donorLocations = [], 
  searchRadiusKm = 15, 
  interactive = true, 
  userLocation = null,
  height = "h-[400px]" 
}) => {
  if (!hospitalLocation || hospitalLocation.length !== 2) return null;

  // Leaflet uses [lat, lng], but backend stores [lng, lat]
  const centerLat = hospitalLocation[1];
  const centerLng = hospitalLocation[0];
  const center = [centerLat, centerLng];

  // If there's a userLocation, we might want to zoom out to fit both, but centering on hospital is safest for static views.
  const zoomLevel = interactive ? 11 : 10;

  return (
    <div className={`w-full ${height} rounded-2xl overflow-hidden border border-base-300 shadow-sm relative z-0`}>
      <MapContainer 
        center={center} 
        zoom={zoomLevel} 
        scrollWheelZoom={interactive}
        dragging={interactive}
        zoomControl={interactive}
        doubleClickZoom={interactive}
        className="w-full h-full"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* Hospital Pin */}
        <Marker position={center} icon={hospitalIcon}>
          {interactive && (
            <Popup>
              <div className="font-bold text-base-content text-sm">Emergency Location</div>
              <div className="text-xs text-base-content/70">Hospital</div>
            </Popup>
          )}
        </Marker>

        {/* 15km Radius Circle */}
        <Circle 
          center={center} 
          pathOptions={{ fillColor: '#DC2626', color: '#DC2626', fillOpacity: 0.1, weight: 1 }} 
          radius={searchRadiusKm * 1000} 
        />

        {/* User Location Pin (Dashboard Mode) */}
        {userLocation && userLocation.length === 2 && (userLocation[0] !== 0 || userLocation[1] !== 0) && (
          <Marker position={[userLocation[1], userLocation[0]]} icon={userIcon}>
            {interactive && (
              <Popup>
                <div className="font-bold text-base-content text-sm">You are here</div>
              </Popup>
            )}
          </Marker>
        )}

        {/* Matched Donor Pins */}
        {donorLocations.map((donor) => {
          if (!donor.location || !donor.location.coordinates || donor.location.coordinates.length !== 2) return null;
          const lat = donor.location.coordinates[1];
          const lng = donor.location.coordinates[0];
          return (
            <Marker key={donor._id} position={[lat, lng]} icon={donorIcon}>
              {interactive && (
                <Popup>
                  <div className="font-bold text-primary mb-1">Compatible Donor</div>
                  <div className="flex items-center gap-2">
                    <span className="badge badge-error badge-sm text-white font-bold">{donor.bloodGroup}</span>
                    <span className="text-xs font-semibold text-success flex items-center gap-1">
                      <div className="w-1.5 h-1.5 rounded-full bg-success"></div>
                      Available
                    </span>
                  </div>
                </Popup>
              )}
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
};

export default DonorMap;
