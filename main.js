(async () => {
  // Vérifie qu'on est sur la bonne page
  const targetUrl = 'https://www.lyonstartup.com/candidat/lsu/evenements';
  
  if (!window.location.href.startsWith(targetUrl)) {
    console.log('⚠️ Mauvaise page ! Redirection vers la page des événements...');
    window.location.href = targetUrl;
    return;
  }
  
  console.log('✅ Sur la bonne page, démarrage du script...\n');
  
  const elements = document.querySelectorAll('[onclick]');
  const dejaInscrits = [];
  const nouveauxInscrits = [];
  const echoues = [];
  const eventsForCalendar = [];
  
  console.log(`📋 ${elements.length} éléments avec onclick trouvés\n`);
  
  for (const el of elements) {
    const onclick = el.getAttribute('onclick');
    const match = onclick.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
    if (match) {
      const url = match[1];
      const fullUrl = window.location.origin + url;
      const reservationUrl = fullUrl + '/reservation';
      
      try {
        // 1. Récupère la page de l'event pour vérifier le statut actuel
        const pageResponse = await fetch(fullUrl, { credentials: 'include' });
        const pageHtml = await pageResponse.text();
        
        const parser = new DOMParser();
        const doc = parser.parseFromString(pageHtml, 'text/html');
        
        const title = doc.querySelector('.event-header h3')?.textContent?.trim() || 'Event';
        const dateRaw = doc.querySelector('.event-header h5')?.textContent?.trim() || '';
        const timeRaw = doc.querySelector('.event-header p span:last-child')?.textContent?.trim() || '';
        const location = doc.querySelector('.event-footer h6:first-of-type')?.textContent?.trim() || '';
        const address = doc.querySelector('.event-footer p div:first-child')?.textContent?.trim() || '';
        const description = doc.querySelector('.event-body div:nth-child(2) p')?.textContent?.trim() || '';
        const horaires = doc.querySelector('.event-body div:nth-child(3) p')?.textContent?.trim() || '';
        
        // Vérifie si DÉJÀ inscrit (bouton "Se désinscrire" présent)
        const dejaInscrit = pageHtml.includes("Se désinscrire de l'événement");
        
        if (dejaInscrit) {
          console.log(`⏭️ DÉJÀ INSCRIT: ${title}`);
          dejaInscrits.push({ event: title, url: fullUrl });
          await new Promise(r => setTimeout(r, 200));
          continue; // Passe au suivant, pas d'ICS
        }
        
        // Parse la date
        const dateMatch = dateRaw.match(/(\d{2})\.(\d{2})\.(\d{4})/);
        let startDate = null;
        let endDate = null;
        
        if (dateMatch) {
          const [, day, month, year] = dateMatch;
          const timeMatch = horaires.match(/(\d{2}):(\d{2}).*?(\d{2}):(\d{2})/);
          if (timeMatch) {
            const [, startH, startM, endH, endM] = timeMatch;
            startDate = `${year}${month}${day}T${startH}${startM}00`;
            endDate = `${year}${month}${day}T${endH}${endM}00`;
          } else {
            const singleTime = timeRaw.match(/(\d{2}):(\d{2})/);
            if (singleTime) {
              startDate = `${year}${month}${day}T${singleTime[1]}${singleTime[2]}00`;
              endDate = `${year}${month}${day}T${String(parseInt(singleTime[1]) + 2).padStart(2, '0')}${singleTime[2]}00`;
            }
          }
        }
        
        // 2. Tente l'inscription
        const response = await fetch(reservationUrl, {
          credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
          mode: "cors"
        });
        
        const html = await response.text();
        const inscrit = html.includes("Se désinscrire de l'événement");
        
        if (inscrit) {
          console.log(`✅ NOUVELLE INSCRIPTION: ${title}`);
          nouveauxInscrits.push({ event: title, url: fullUrl });
          
          // Ajoute au calendrier seulement les NOUVEAUX
          if (startDate) {
            eventsForCalendar.push({
              title,
              startDate,
              endDate,
              location: `${location} - ${address}`,
              description,
              url: fullUrl
            });
          }
        } else {
          console.log(`❌ ÉCHEC INSCRIPTION: ${title}`);
          echoues.push({ event: title, url: fullUrl });
        }
        
        await new Promise(r => setTimeout(r, 500));
        
      } catch (e) {
        console.log(`⚠️ Erreur: ${e.message}`);
        echoues.push({ event: url, error: e.message });
      }
    }
  }
  
  // Résumé
  console.log('\n' + '='.repeat(50));
  console.log('               RÉSUMÉ');
  console.log('='.repeat(50));
  console.log(`⏭️ Déjà inscrit (ignorés):    ${dejaInscrits.length}`);
  console.log(`✅ Nouvelles inscriptions:    ${nouveauxInscrits.length}`);
  console.log(`❌ Échecs:                    ${echoues.length}`);
  console.log('='.repeat(50));
  
  if (dejaInscrits.length > 0) {
    console.log('\n⏭️ --- Déjà inscrit (pas dans l\'ICS) ---');
    dejaInscrits.forEach(r => console.log(`   • ${r.event}`));
  }
  
  if (nouveauxInscrits.length > 0) {
    console.log('\n✅ --- Nouvelles inscriptions (dans l\'ICS) ---');
    nouveauxInscrits.forEach(r => console.log(`   • ${r.event}`));
  }
  
  if (echoues.length > 0) {
    console.log('\n❌ --- Échecs ---');
    echoues.forEach(r => console.log(`   • ${r.event}`));
  }
  
  // Génère l'ICS seulement avec les NOUVEAUX events
  if (eventsForCalendar.length > 0) {
    let ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Lyon Startup//LSU19//FR
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:Lyon Startup - Nouvelles inscriptions
X-WR-TIMEZONE:Europe/Paris
`;

    eventsForCalendar.forEach(e => {
      const uid = `lsu-${e.startDate}-${Date.now()}@lyonstartup.com`;
      const desc = (e.description || '').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;').substring(0, 500);
      const loc = (e.location || '').replace(/,/g, '\\,').replace(/;/g, '\\;');
      const titleClean = (e.title || '').replace(/,/g, '\\,').replace(/;/g, '\\;');
      
      ics += `BEGIN:VEVENT
DTSTART:${e.startDate}
DTEND:${e.endDate}
SUMMARY:${titleClean}
DESCRIPTION:${desc}\\n\\nLien: ${e.url}
LOCATION:${loc}
URL:${e.url}
UID:${uid}
END:VEVENT
`;
    });

    ics += 'END:VCALENDAR';

    const blob = new Blob([ics], {type: 'text/calendar'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lyon-startup-nouvelles-inscriptions.ics';
    a.click();

    console.log(`\n📅 Fichier ICS téléchargé avec ${eventsForCalendar.length} NOUVEAUX événements !`);
  } else if (nouveauxInscrits.length === 0) {
    console.log('\n📅 Aucune nouvelle inscription, pas de fichier ICS généré');
  }
})();