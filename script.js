(function() {
    'use strict';

    // Konfigurasi
    const KABUPATEN_NAMES = ['Kota Yogyakarta', 'Sleman', 'Bantul', 'Kulon Progo', 'Gunungkidul'];
    const KABUPATEN_COORDS = {
        'Kota Yogyakarta': [110.3644, -7.7956],
        'Sleman': [110.3237, -7.6799],
        'Bantul': [110.3269, -7.8881],
        'Kulon Progo': [110.1524, -7.7543],
        'Gunungkidul': [110.6197, -7.9843]
    };
    const BOUNDS = {
        temp: { min: 24, max: 35 },
        rain: { min: 10, max: 320 },
        humidity: { min: 55, max: 98 },
        wind: { min: 1, max: 22 }
    };
    const RISK_LEVELS = [
        { key: 'very-low', label: 'Sangat Rendah', color: '#4caf50', scoreMin: 0, scoreMax: 20 },
        { key: 'low', label: 'Rendah', color: '#8bc34a', scoreMin: 21, scoreMax: 40 },
        { key: 'medium', label: 'Sedang', color: '#ffeb3b', scoreMin: 41, scoreMax: 60 },
        { key: 'high', label: 'Tinggi', color: '#ff9800', scoreMin: 61, scoreMax: 80 },
        { key: 'very-high', label: 'Sangat Tinggi', color: '#f44336', scoreMin: 81, scoreMax: 100 }
    ];

    let map, geoJsonLayer, fallbackCircles = [];
    let kabupatenData = {}, kecamatanData = {};
    let chartInstance;
    let isGeoJSONLoaded = false;
    let mapInitialized = false;

    // DOM
    const $clock = document.getElementById('clock');
    const $updateInfo = document.getElementById('updateInfo');
    const $toast = document.getElementById('toast');
    const $toastTitle = document.getElementById('toastTitle');
    const $toastBody = document.getElementById('toastBody');
    const $alertLog = document.getElementById('alertLog');

    // Helpers
    function randomBetween(min, max) { return Math.round((Math.random() * (max - min) + min) * 10) / 10; }
    function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }
    function getRiskLevel(score) {
        for (const level of RISK_LEVELS) {
            if (score >= level.scoreMin && score <= level.scoreMax) return level;
        }
        return RISK_LEVELS[0];
    }

    // Perhitungan risiko
    function calculateRisk(data) {
        let tempScore = 0, t = data.temp;
        if (t >= 27 && t <= 30) tempScore = 100;
        else if (t >= 25 && t < 27) tempScore = 70 + (t - 25) * 15;
        else if (t > 30 && t <= 33) tempScore = 100 - (t - 30) * 20;
        else if (t > 33) tempScore = 40;
        else if (t < 25) tempScore = 40 + (t - 24) * 30;
        tempScore = clamp(tempScore, 0, 100);

        let rainScore = clamp((data.rain / 250) * 100, 0, 100);

        let humidityScore = 0, h = data.humidity;
        if (h >= 80) humidityScore = 100;
        else if (h >= 70) humidityScore = 60 + (h - 70) * 4;
        else if (h >= 60) humidityScore = 20 + (h - 60) * 4;
        else humidityScore = clamp((h - 50) * 2, 0, 20);

        let windScore = 0, w = data.wind;
        if (w <= 3) windScore = 100;
        else if (w <= 8) windScore = 80 - (w - 3) * 4;
        else if (w <= 15) windScore = 60 - (w - 8) * 3;
        else windScore = 20;
        windScore = clamp(windScore, 0, 100);

        return Math.round(clamp((tempScore * 0.35) + (rainScore * 0.30) + (humidityScore * 0.20) + (windScore * 0.15), 0, 100));
    }

    // Data kabupaten
    function generateKabupatenData(name, existing) {
        const base = existing || {};
        const walk = (old, min, max, step) => {
            if (old === undefined) return randomBetween(min, max);
            let v = old + randomBetween(-step, step);
            return clamp(v, min, max);
        };
        const temp = Math.round(walk(base.temp, BOUNDS.temp.min, BOUNDS.temp.max, 0.8) * 10) / 10;
        const rain = Math.round(walk(base.rain, BOUNDS.rain.min, BOUNDS.rain.max, 12) * 10) / 10;
        const humidity = Math.round(walk(base.humidity, BOUNDS.humidity.min, BOUNDS.humidity.max, 2.5) * 10) / 10;
        const wind = Math.round(walk(base.wind, BOUNDS.wind.min, BOUNDS.wind.max, 1.2) * 10) / 10;
        const data = { temp, rain, humidity, wind };
        const score = calculateRisk(data);
        const level = getRiskLevel(score);
        return { name, ...data, score, riskKey: level.key, riskLabel: level.label, riskColor: level.color };
    }

    function updateKabupatenData() {
        KABUPATEN_NAMES.forEach(name => {
            kabupatenData[name] = generateKabupatenData(name, kabupatenData[name]);
        });
    }

    function initKabupatenData() {
        KABUPATEN_NAMES.forEach(name => {
            kabupatenData[name] = generateKabupatenData(name, null);
        });
    }

    // Inisialisasi peta
    function initMap() {
        if (mapInitialized) return;
        map = L.map('map').setView([-7.8, 110.4], 10);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap',
            maxZoom: 19,
        }).addTo(map);
        mapInitialized = true;

        loadGeoJSON();
    }

    // Daftar sumber GeoJSON
    const GEOJSON_SOURCES = [
        'https://raw.githubusercontent.com/indonesia-geojson/indonesia-geojson/master/kecamatan/34-daerah-istimewa-yogyakarta.geojson',
        'https://raw.githubusercontent.com/kelvinharyono/geojson-indonesia/master/kabupaten/34-daerah-istimewa-yogyakarta.json',
        'https://raw.githubusercontent.com/putrapradana/geojson-indonesia/master/daerah-istimewa-yogyakarta/kecamatan.json'
    ];

    function loadGeoJSON() {
        let attempt = 0;
        let loaded = false;

        function tryNext() {
            if (attempt >= GEOJSON_SOURCES.length || loaded) {
                if (!loaded) {
                    console.warn('Semua sumber GeoJSON gagal. Menggunakan fallback lingkaran.');
                    renderFallbackCircles();
                }
                return;
            }
            const url = GEOJSON_SOURCES[attempt];
            attempt++;
            fetch(url)
                .then(res => {
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    return res.json();
                })
                .then(data => {
                    if (data && (data.features || Array.isArray(data))) {
                        console.log('✅ GeoJSON dimuat dari:', url);
                        loaded = true;
                        isGeoJSONLoaded = true;
                        renderGeoJSON(data);
                    } else {
                        throw new Error('Data tidak valid');
                    }
                })
                .catch(err => {
                    console.warn('❌ Gagal memuat', url, err.message);
                    tryNext();
                });
        }
        tryNext();
    }

    // Render GeoJSON
    function renderGeoJSON(data) {
        if (geoJsonLayer) map.removeLayer(geoJsonLayer);
        if (fallbackCircles.length) {
            fallbackCircles.forEach(c => map.removeLayer(c));
            fallbackCircles = [];
        }

        let features = data.features || [];
        if (features.length === 0 && Array.isArray(data)) features = data;

        if (features.length === 0) {
            throw new Error('Tidak ada fitur dalam GeoJSON');
        }

        geoJsonLayer = L.geoJSON(data, {
            style: function() {
                return { weight: 1, color: '#333', fillColor: '#555', fillOpacity: 0.6 };
            },
            onEachFeature: function(feature, layer) {
                const props = feature.properties;
                let name = props.kecamatan || props.nama || props.NAMA_KEC || props.KECAMATAN || props.kabupaten || props.KABUPATEN || 'Wilayah';
                layer._nama = name;

                layer.on('click', function(e) {
                    const d = layer._kecData;
                    if (d) {
                        const content = `
                            <strong>${d.nama}</strong><br>
                            ${d.kabupaten ? 'Kabupaten: '+d.kabupaten+'<br>' : ''}
                            <span style="color:${d.riskColor};font-weight:bold;">Risiko: ${d.riskLabel} (${d.score})</span><br>
                            🌡️ ${d.temp}°C | 🌧️ ${d.rain} mm<br>
                            💧 ${d.humidity}% | 💨 ${d.wind} km/h
                        `;
                        layer.bindPopup(content).openPopup();
                    } else {
                        layer.bindPopup(`<strong>${name}</strong><br>Data risiko belum tersedia.`).openPopup();
                    }
                });

                if (name && name !== 'Wilayah') {
                    layer.bindTooltip(name, {
                        permanent: false,
                        direction: 'center',
                        className: 'kecamatan-label'
                    });
                }
            }
        }).addTo(map);

        updateKecamatanData();
        updateGeoJSONStyle();
        updateStatsAndChart();

        try {
            map.fitBounds(geoJsonLayer.getBounds().pad(0.1));
        } catch (e) {}
    }

    function updateKecamatanData() {
        if (!geoJsonLayer) return;
        const newData = {};
        geoJsonLayer.eachLayer(layer => {
            if (layer.feature) {
                const props = layer.feature.properties;
                const name = props.kecamatan || props.nama || props.NAMA_KEC || props.KECAMATAN || props.kabupaten || props.KABUPATEN || 'Wilayah';
                let kabRef = KABUPATEN_NAMES.find(k =>
                    name.toLowerCase().includes(k.toLowerCase()) ||
                    k.toLowerCase().includes(name.toLowerCase())
                );
                if (!kabRef) {
                    const kabProp = props.kabupaten || props.KABUPATEN || '';
                    kabRef = KABUPATEN_NAMES.find(k =>
                        kabProp.toLowerCase().includes(k.toLowerCase()) ||
                        k.toLowerCase().includes(kabProp.toLowerCase())
                    );
                }
                if (!kabRef) kabRef = KABUPATEN_NAMES[0];
                const kabData = kabupatenData[kabRef] || kabupatenData[KABUPATEN_NAMES[0]];
                const variance = randomBetween(-15, 15);
                let score = clamp(kabData.score + variance, 0, 100);
                const level = getRiskLevel(score);
                const temp = clamp(kabData.temp + randomBetween(-2, 2), BOUNDS.temp.min, BOUNDS.temp.max);
                const rain = clamp(kabData.rain + randomBetween(-20, 20), BOUNDS.rain.min, BOUNDS.rain.max);
                const humidity = clamp(kabData.humidity + randomBetween(-5, 5), BOUNDS.humidity.min, BOUNDS.humidity.max);
                const wind = clamp(kabData.wind + randomBetween(-2, 2), BOUNDS.wind.min, BOUNDS.wind.max);
                const data = {
                    nama: name,
                    kabupaten: kabRef,
                    temp: Math.round(temp * 10) / 10,
                    rain: Math.round(rain * 10) / 10,
                    humidity: Math.round(humidity * 10) / 10,
                    wind: Math.round(wind * 10) / 10,
                    score,
                    riskKey: level.key,
                    riskLabel: level.label,
                    riskColor: level.color,
                };
                const id = layer.feature.id || layer.feature.properties.id || layer._leaflet_id;
                newData[id] = data;
                layer._kecData = data;
            }
        });
        kecamatanData = newData;
    }

    function updateGeoJSONStyle() {
        if (!geoJsonLayer) return;
        geoJsonLayer.eachLayer(layer => {
            const d = layer._kecData;
            if (d) {
                layer.setStyle({
                    fillColor: d.riskColor,
                    fillOpacity: 0.7,
                    weight: 1.5,
                    color: '#1a3a1a',
                    opacity: 0.8,
                });
            }
        });
    }

    // FALLBACK LINGKARAN
    function renderFallbackCircles() {
        if (geoJsonLayer) map.removeLayer(geoJsonLayer);
        if (fallbackCircles.length) {
            fallbackCircles.forEach(c => map.removeLayer(c));
            fallbackCircles = [];
        }

        for (const name of KABUPATEN_NAMES) {
            const data = kabupatenData[name];
            const [lng, lat] = KABUPATEN_COORDS[name] || [110, -7.8];
            const radius = 8000 + (data.score / 100) * 22000;
            const circle = L.circle([lat, lng], {
                radius: radius,
                color: data.riskColor,
                fillColor: data.riskColor,
                fillOpacity: 0.6,
                weight: 2,
                opacity: 0.8,
            }).addTo(map);
            circle.bindTooltip(`
                <strong>${name}</strong><br>
                Risiko: ${data.riskLabel} (${data.score})<br>
                Suhu: ${data.temp}°C | Hujan: ${data.rain} mm
            `);
            fallbackCircles.push(circle);
        }

        if (fallbackCircles.length) {
            const group = L.featureGroup(fallbackCircles);
            map.fitBounds(group.getBounds().pad(0.1));
        }

        isGeoJSONLoaded = false;
        updateStatsAndChart();
    }

    // Statistik & Chart
    function updateStatsAndChart() {
        let total = 0, veryHigh = 0, high = 0, low = 0;
        let sumTemp = 0, sumRain = 0;
        let dataList = [];

        if (isGeoJSONLoaded && geoJsonLayer) {
            dataList = Object.values(kecamatanData);
        } else {
            dataList = Object.values(kabupatenData);
        }

        total = dataList.length;
        dataList.forEach(d => {
            if (d.riskKey === 'very-high') veryHigh++;
            else if (d.riskKey === 'high') high++;
            else if (d.riskKey === 'low' || d.riskKey === 'very-low') low++;
            sumTemp += d.temp;
            sumRain += d.rain;
        });

        document.getElementById('totalRegions').textContent = total;
        document.getElementById('veryHighCount').textContent = veryHigh;
        document.getElementById('highCount').textContent = high;
        document.getElementById('lowCount').textContent = low;
        document.getElementById('avgTemp').innerHTML = `${total > 0 ? (sumTemp/total).toFixed(1) : '--'} <span class="unit">°C</span>`;
        document.getElementById('avgRain').innerHTML = `${total > 0 ? (sumRain/total).toFixed(1) : '--'} <span class="unit">mm</span>`;

        const counts = { 'very-low': 0, low: 0, medium: 0, high: 0, 'very-high': 0 };
        dataList.forEach(d => counts[d.riskKey] = (counts[d.riskKey] || 0) + 1);
        document.getElementById('distVeryLow').textContent = counts['very-low'];
        document.getElementById('distLow').textContent = counts.low;
        document.getElementById('distMedium').textContent = counts.medium;
        document.getElementById('distHigh').textContent = counts.high;
        document.getElementById('distVeryHigh').textContent = counts['very-high'];

        updateChart(counts);
    }

    function updateChart(counts) {
        const labels = ['Sangat Rendah', 'Rendah', 'Sedang', 'Tinggi', 'Sangat Tinggi'];
        const keys = ['very-low', 'low', 'medium', 'high', 'very-high'];
        const data = keys.map(k => counts[k] || 0);
        const colors = ['#4caf50', '#8bc34a', '#ffeb3b', '#ff9800', '#f44336'];

        const ctx = document.getElementById('riskChart').getContext('2d');
        if (chartInstance) chartInstance.destroy();
        chartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels,
                datasets: [{
                    data,
                    backgroundColor: colors,
                    borderColor: colors.map(c => c + 'aa'),
                    borderWidth: 2,
                    hoverOffset: 8,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(ctx) {
                                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                                const pct = total > 0 ? Math.round((ctx.parsed / total) * 100) : 0;
                                return `${ctx.label}: ${ctx.parsed} wilayah (${pct}%)`;
                            }
                        }
                    }
                },
                cutout: '65%',
            }
        });
    }

    // Alert & Toast
    function checkAlerts() {
        const dataList = isGeoJSONLoaded ? Object.values(kecamatanData) : Object.values(kabupatenData);
        const highRisk = dataList.filter(r => r.riskKey === 'high' || r.riskKey === 'very-high');
        if (highRisk.length === 0) return;

        const worst = highRisk.sort((a, b) => b.score - a.score)[0];
        const name = worst.nama || worst.name || 'Wilayah';
        const levelLabel = worst.riskKey === 'very-high' ? 'SANGAT TINGGI' : 'TINGGI';

        $toastTitle.textContent = `⚠️ Peringatan DBD — ${name}`;
        $toastBody.textContent = `Wilayah ${name} risiko ${levelLabel} (${worst.score}). Suhu ${worst.temp}°C, hujan ${worst.rain}mm.`;
        $toast.classList.add('show');
        clearTimeout(window._toastTimer);
        window._toastTimer = setTimeout(() => $toast.classList.remove('show'), 6000);

        const time = new Date();
        const pad = n => String(n).padStart(2, '0');
        const tStr = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
        const log = document.getElementById('alertLog');
        if (log.children.length === 1 && log.children[0].textContent.includes('Menunggu')) log.innerHTML = '';
        log.insertAdjacentHTML('afterbegin', `
            <div class="alert-item alert-${worst.riskKey === 'very-high' ? 'red' : 'orange'}">
                <span>🔴 ${name} — ${levelLabel} (${worst.score})</span>
                <span class="a-time">${tStr}</span>
            </div>
        `);
        while (log.children.length > 20) log.removeChild(log.lastChild);
    }

    // Jam
    function updateClock() {
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        $clock.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }

    function updateTimestamp() {
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        $updateInfo.textContent = `Diperbarui: ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }

    // Update cycle
    function fullUpdate() {
        updateKabupatenData();
        if (isGeoJSONLoaded && geoJsonLayer) {
            updateKecamatanData();
            updateGeoJSONStyle();
        } else {
            if (fallbackCircles.length) {
                fallbackCircles.forEach(c => map.removeLayer(c));
                fallbackCircles = [];
                renderFallbackCircles();
            } else {
                renderFallbackCircles();
            }
        }
        updateStatsAndChart();
        updateTimestamp();
        checkAlerts();
    }

    // Init
    function init() {
        initKabupatenData();
        initMap();
        updateClock();
        updateTimestamp();
        setInterval(updateClock, 1000);
        setInterval(fullUpdate, 4000);
        setTimeout(() => $toast.classList.remove('show'), 200);
        console.log('✅ DENTECH Peta Kecamatan siap.');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

})();